import { createWriteStream } from 'node:fs';
import Client from 'ftp';

import type { BackItUpConfigStorageFtp, BackItUpStorage } from '../types';
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
type FtpOptions = Partial<BackItUpConfigStorageFtp> & {
    ftp?: Partial<BackItUpConfigStorageFtp>;
};

interface FtpSettings {
    host: string;
    user: string;
    pass: string;
    port: string | number;
    secure: boolean;
    signedCertificates: boolean;
    dir: string;
    ownDir: boolean;
    dirMinimal: string;
}

function settings(options: FtpOptions): FtpSettings {
    return {
        host:
            options.host !== undefined
                ? options.host
                : options.ftp && options.ftp.host !== undefined
                  ? options.ftp.host
                  : '',
        user:
            options.user !== undefined
                ? options.user
                : options.ftp && options.ftp.user !== undefined
                  ? options.ftp.user
                  : '',
        pass:
            options.pass !== undefined
                ? options.pass
                : options.ftp && options.ftp.pass !== undefined
                  ? options.ftp.pass
                  : '',
        port:
            options.port !== undefined
                ? options.port
                : options.ftp && options.ftp.port !== undefined
                  ? options.ftp.port
                  : 21,
        secure:
            options.secure !== undefined
                ? options.secure
                : options.ftp && options.ftp.secure !== undefined
                  ? options.ftp.secure
                  : false,
        signedCertificates:
            options.signedCertificates !== undefined
                ? !!options.signedCertificates
                : options.ftp && options.ftp.signedCertificates !== undefined
                  ? !!options.ftp.signedCertificates
                  : true,
        dir:
            options.dir !== undefined
                ? (options.dir as string)
                : options.ftp && options.ftp.dir !== undefined
                  ? (options.ftp.dir as string)
                  : '/',
        ownDir:
            options.ownDir !== undefined
                ? options.ownDir
                : options.ftp && options.ftp.ownDir !== undefined
                  ? options.ftp.ownDir
                  : false,
        dirMinimal:
            options.dirMinimal !== undefined
                ? options.dirMinimal
                : options.ftp && options.ftp.dirMinimal !== undefined
                  ? options.ftp.dirMinimal
                  : '/',
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

/**
 * Builds the connection options.
 *
 * Careful with `rejectUnauthorized`: `!!x || true` is `true` for every input, so the
 * "allow only signed certificates" setting has never had any effect here and the certificate is
 * always verified. Left exactly as it was - making the flag work would silently switch off
 * certificate checking for everyone who unticked it.
 *
 * @param cfg resolved storage settings
 */
function connectOptions(cfg: FtpSettings): Client.Options {
    return {
        host: cfg.host,
        port: (cfg.port as number) || 21,
        secure: cfg.secure || false,
        secureOptions: { rejectUnauthorized: !!cfg.signedCertificates || true },
        user: cfg.user,
        password: cfg.pass,
    };
}

export function list(
    restoreSource: BackItUpStorage | '' | undefined,
    options: FtpOptions,
    types: string[],
    log: ioBroker.Logger,
    callback?: BackItUpListCallback,
): void {
    const cfg = settings(options);

    if (cfg.host && (!restoreSource || restoreSource === 'ftp')) {
        const client = new Client();

        const dir = targetDir(cfg.dir, cfg.ownDir, cfg.dirMinimal);

        // Only the error handler clears the callback, matching the original: an error after a
        // successful listing is swallowed, a listing after an error is not.
        let cb = callback;

        client.on('ready', () => {
            log.debug('FTP: connected.');
            client.list(dir, (err, result) => {
                if (err) {
                    log.error(`FTP: ${err}`);
                }
                client.end();
                if (result && result.length) {
                    let entries: BackItUpStorageEngineResultFile[] = [];
                    try {
                        entries = result
                            .map(file => ({
                                path: file.name,
                                name: file.name.replace(/\\/g, '/').split('/').pop() as string,
                                size: file.size,
                            }))
                            .filter(
                                file =>
                                    (types.indexOf(file.name.split('_')[0]) !== -1 ||
                                        types.indexOf(file.name.split('.')[0]) !== -1) &&
                                    file.name.split('.').pop() == 'gz',
                            );
                    } catch (e) {
                        log.error(`FTP: error on ftp list: ${e} please check the ftp config!!`);
                    }

                    const files: BackItUpStorageEngineResult = {};
                    try {
                        entries.forEach(file => {
                            const type = file.name.split('_')[0];
                            files[type] = files[type] || [];
                            files[type].push(file);
                        });
                    } catch (e) {
                        log.error(`FTP: Files error: ${e} please check the ftp config and try again!!`);
                    }

                    cb?.(null, files, 'ftp');
                } else {
                    cb?.();
                }
            });
        });

        client.on('error', err => {
            if (cb) {
                cb(err);
                cb = undefined;
            }
        });

        client.connect(connectOptions(cfg));
    } else {
        setImmediate(() => callback?.());
    }
}

export function getFile(
    options: FtpOptions,
    fileName: string,
    toStoreName: string,
    log: ioBroker.Logger,
    callback?: BackItUpGetFileCallback,
): void {
    const cfg = settings(options);

    if (cfg.host) {
        // copy file to backupDir
        const client = new Client();

        const dir = targetDir(cfg.dir, cfg.ownDir, cfg.dirMinimal);

        let cb = callback;
        const finish = (err?: Error | string | null): void => {
            if (cb) {
                const fire = cb;
                cb = undefined;
                fire(err);
            }
        };

        client.on('ready', () => {
            log.debug('FTP: connected.');
            log.debug(`FTP: Get file: ${dir}/${fileName}`);
            client.get(`${dir}/${fileName}`, (err, stream) => {
                if (err) {
                    try {
                        client.end();
                    } catch {
                        // ignore
                    }
                    log.error(`FTP: ${err}`);
                    finish(err);
                } else {
                    try {
                        stream.once('close', () => {
                            log.debug('FTP: Download done');
                            client.end();
                            finish();
                        });
                        const writeStream = createWriteStream(toStoreName);
                        writeStream.on('error', writeErr => {
                            log.error(`FTP: ${writeErr}`);
                            // Reports success even though writing failed - kept as it was.
                            finish();
                        });

                        stream.pipe(writeStream);
                    } catch (e) {
                        log.error(`FTP: ${e}`);
                        finish(e as Error);
                    }
                }
            });
        });

        client.on('error', err => finish(err));

        client.connect(connectOptions(cfg));
    } else {
        setImmediate(() => callback?.('Not configured'));
    }
}
