import { createWriteStream } from 'node:fs';
import { Agent } from 'node:https';
// webdav ships as ESM only; this module stays CommonJS, so the types have to be pulled in with an
// explicit resolution mode and the value import below has to remain a dynamic `import()`.
import type { FileStat, WebDAVClient } from 'webdav' with { 'resolution-mode': 'import' };

import type { BackItUpConfigStorageWebDav, BackItUpStorage } from '../types';
import type {
    BackItUpGetFileCallback,
    BackItUpListCallback,
    BackItUpStorageEngineResult,
    BackItUpStorageEngineResultFile,
} from './types';

/**
 * The engines are handed either the storage node itself or the enclosing creator node, which
 * carries the storage under its own key - hence the two-step lookup on every setting.
 */
type WebDavOptions = Partial<BackItUpConfigStorageWebDav> & {
    webdav?: Partial<BackItUpConfigStorageWebDav>;
};

interface WebDavSettings {
    username: string;
    pass: string;
    url: string;
    dir: string;
    dirMinimal: string;
    ownDir: boolean;
    signedCertificates: boolean;
}

function settings(options: WebDavOptions): WebDavSettings {
    return {
        username:
            options.username !== undefined
                ? options.username
                : options.webdav && options.webdav.username !== undefined
                  ? options.webdav.username
                  : '',
        pass:
            options.pass !== undefined
                ? options.pass
                : options.webdav && options.webdav.pass !== undefined
                  ? options.webdav.pass
                  : '',
        url:
            options.url !== undefined
                ? options.url
                : options.webdav && options.webdav.url !== undefined
                  ? options.webdav.url
                  : '',
        dir:
            options.dir !== undefined
                ? (options.dir as string)
                : options.webdav && options.webdav.dir !== undefined
                  ? (options.webdav.dir as string)
                  : '/',
        dirMinimal:
            options.dirMinimal !== undefined
                ? options.dirMinimal
                : options.webdav && options.webdav.dirMinimal !== undefined
                  ? options.webdav.dirMinimal
                  : '/',
        ownDir:
            options.ownDir !== undefined
                ? options.ownDir
                : options.webdav && options.webdav.ownDir !== undefined
                  ? options.webdav.ownDir
                  : false,
        signedCertificates:
            options.signedCertificates !== undefined
                ? options.signedCertificates
                : options.webdav && options.webdav.signedCertificates !== undefined
                  ? options.webdav.signedCertificates
                  : true,
    };
}

/**
 * Applies the "own directory" switch and makes sure the path is absolute
 *
 * @param dir configured target directory
 * @param ownDir whether the minimal backup uses its own directory
 * @param dirMinimal directory used when `ownDir` is set
 */
function targetDir(dir: string, ownDir: boolean, dirMinimal: string): string {
    let result = (dir || '').replace(/\\/g, '/');

    if (ownDir === true) {
        result = (dirMinimal || '').replace(/\\/g, '/');
    }

    if (!result || result[0] !== '/') {
        result = `/${result || ''}`;
    }

    return result;
}

export async function list(
    restoreSource: BackItUpStorage | '' | undefined,
    options: WebDavOptions,
    types: string[],
    log: ioBroker.Logger,
    callback?: BackItUpListCallback,
): Promise<void> {
    try {
        const cfg = settings(options);

        if (cfg.username && cfg.pass && cfg.url && (!restoreSource || restoreSource === 'webdav')) {
            // webdav is ESM only, so it has to be pulled in with a dynamic import
            const { createClient } = await import('webdav');
            const agent = new Agent({ rejectUnauthorized: Boolean(cfg.signedCertificates) });
            let client: WebDAVClient | undefined;
            try {
                client = createClient(cfg.url, {
                    username: cfg.username,
                    password: cfg.pass,
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                    httpsAgent: agent,
                });
            } catch (err) {
                log.error(`cannot conntect to WebDAV: ${err}`);
                callback?.();
                // No early return on purpose: the code below then dereferences the client that was
                // never created, the resulting TypeError is caught by the try that follows, and the
                // callback fires a second time - this time with that error. Preserved.
            }

            const dir = targetDir(cfg.dir, cfg.ownDir, cfg.dirMinimal);

            try {
                client!
                    .getDirectoryContents(dir)
                    .then(contents => {
                        if (contents) {
                            const entries: BackItUpStorageEngineResultFile[] = contents
                                .map(file => ({
                                    path: file.filename,
                                    name: file.filename.replace(/\\/g, '/').split('/').pop() as string,
                                    size: file.size,
                                }))
                                .filter(
                                    file =>
                                        (types.indexOf(file.name.split('_')[0]) !== -1 ||
                                            types.indexOf(file.name.split('.')[0]) !== -1) &&
                                        file.name.split('.').pop() == 'gz',
                                );

                            const files: BackItUpStorageEngineResult = {};
                            entries.forEach(file => {
                                const type = file.name.split('_')[0];
                                files[type] = files[type] || [];
                                files[type].push(file);
                            });
                            callback?.(null, files, 'webdav');
                        } else {
                            callback?.();
                        }
                    })
                    .catch(err => {
                        log.error(`cannot conntect to WebDAV: ${err}`);
                        callback?.();
                    });
            } catch (e) {
                setImmediate(() => callback?.(e as Error));
            }
        } else {
            setImmediate(() => callback?.());
        }
    } catch (err) {
        log.error(`WebDAV: ${err}`);
        callback?.();
    }
}

export async function getFile(
    options: WebDavOptions,
    fileName: string,
    toStoreName: string,
    log: ioBroker.Logger,
    callback?: BackItUpGetFileCallback,
): Promise<void> {
    const cfg = settings(options);

    if (cfg.username && cfg.pass && cfg.url) {
        // webdav is ESM only, so it has to be pulled in with a dynamic import
        const { createClient } = await import('webdav');
        // Note: unlike in `list` the flag is passed through without Boolean() - kept as it was.
        const agent = new Agent({ rejectUnauthorized: cfg.signedCertificates });
        // copy file to backupDir
        let client: WebDAVClient | undefined;
        try {
            client = createClient(cfg.url, {
                username: cfg.username,
                password: cfg.pass,
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                httpsAgent: agent,
            });
        } catch (err) {
            log.error(`cannot conntect to WebDAV: ${err}`);
            callback?.();
            // As above: no early return, the following dereference throws into the try below.
        }

        try {
            log.debug(`WebDAV: Download of "${fileName}" started`);

            // Fires at most once, whichever of the two stream events comes first.
            let done: BackItUpGetFileCallback | undefined = callback;
            const finish = (err?: Error | string | null): void => {
                if (done) {
                    const fire = done;
                    done = undefined;
                    fire(err);
                }
            };

            const writeStream = createWriteStream(toStoreName);
            writeStream
                .on('error', err => {
                    log.error(`WebDAV: ${err}`);
                    finish(err);
                })
                .on('close', () => {
                    log.debug(`WebDAV: Download of "${fileName}" finish`);
                    finish();
                });
            client!.createReadStream(fileName).pipe(writeStream);
        } catch (e) {
            log.debug(String(e));
            if (callback) {
                setImmediate(() => callback(e as Error));
            }
        }
    } else if (callback) {
        setImmediate(() => callback('Not configured'));
    }
}
