import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { authenticate } from 'dropbox-v2-api';

import type { BackItUpConfigStorageDropbox, BackItUpStorage } from '../types';
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
type DropboxOptions = Partial<BackItUpConfigStorageDropbox> & {
    dropbox?: Partial<BackItUpConfigStorageDropbox>;
};

/** Kept at module scope, as before */
let db_accessToken: string | undefined;

function settings(options: DropboxOptions): { dir: string; ownDir: boolean; dirMinimal: string } {
    return {
        dir:
            options.dir !== undefined
                ? (options.dir as string)
                : options.dropbox && options.dropbox.dir !== undefined
                  ? (options.dropbox.dir as string)
                  : '/',
        ownDir:
            options.ownDir !== undefined
                ? options.ownDir
                : options.dropbox && options.dropbox.ownDir !== undefined
                  ? options.dropbox.ownDir
                  : false,
        dirMinimal:
            options.dirMinimal !== undefined
                ? options.dirMinimal
                : options.dropbox && options.dropbox.dirMinimal !== undefined
                  ? options.dropbox.dirMinimal
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

export async function list(
    restoreSource: BackItUpStorage | '' | undefined,
    options: DropboxOptions,
    types: string[],
    log: ioBroker.Logger,
    callback?: BackItUpListCallback,
): Promise<void> {
    const { dir: dbDir, ownDir, dirMinimal } = settings(options);

    // Token refresh
    if (!restoreSource || restoreSource === 'dropbox') {
        db_accessToken = options.accessToken || '';
    }

    if (db_accessToken && (!restoreSource || restoreSource === 'dropbox')) {
        const dbx = authenticate({ token: db_accessToken });

        const dir = targetDir(dbDir, ownDir, dirMinimal);

        try {
            dbx(
                {
                    resource: 'files/list_folder',
                    parameters: {
                        path: dir.replace(/^\/$/, ''),
                    },
                },
                (err, result) => {
                    if (err && err.error_summary) {
                        log.error(`Dropbox: ${JSON.stringify(err.error_summary)}`);
                    }
                    if (result && result.entries) {
                        const entries: BackItUpStorageEngineResultFile[] = (result.entries as any[])
                            .map((file: any) => ({
                                path: file.path_display,
                                name: file.path_display.replace(/\\/g, '/').split('/').pop() as string,
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

                        callback?.(null, files, 'dropbox');
                    } else {
                        callback?.(
                            `Dropbox: ${err?.error_summary ? JSON.stringify(err.error_summary) : 'Error on Dropbox list'}`,
                        );
                    }
                },
            );
        } catch (e) {
            setImmediate(() => callback?.(e as Error));
        }
    } else {
        setImmediate(() => callback?.());
    }
}

export async function getFile(
    options: DropboxOptions,
    fileName: string,
    toStoreName: string,
    log: ioBroker.Logger,
    callback?: BackItUpGetFileCallback,
): Promise<void> {
    const { dir: dbDir, ownDir, dirMinimal } = settings(options);

    // Token refresh
    const accessToken = options.accessToken || '';

    if (accessToken) {
        // copy file to backupDir
        const dbx = authenticate({ token: accessToken });

        const onlyFileName = fileName.split('/').pop() as string;

        const dir = targetDir(dbDir, ownDir, dirMinimal);

        // Fires at most once, whichever of the write stream and the request reports first.
        let done: BackItUpGetFileCallback | undefined = callback;
        const finish = (err?: Error | string | null): void => {
            if (done) {
                const fire = done;
                done = undefined;
                fire(err);
            }
        };

        try {
            log.debug(`Dropbox: Download of "${fileName}" started`);

            const writeStream = createWriteStream(toStoreName);
            writeStream.on('error', err => {
                if (err) {
                    log.error(`Dropbox: ${err}`);
                }
                finish(err);
            });

            dbx(
                {
                    resource: 'files/download',
                    parameters: {
                        path: join(dir.replace(/^\/$/, ''), onlyFileName).replace(/\\/g, '/'),
                    },
                },
                err => {
                    if (err) {
                        log.error(`Dropbox: ${err}`);
                    } else {
                        log.debug(`Dropbox: Download of "${fileName}" done`);
                    }
                    finish(err);
                },
            ).pipe(writeStream);
        } catch (e) {
            if (callback) {
                setImmediate(() => finish(e as Error));
            }
        }
    } else if (callback) {
        setImmediate(() => callback('Not configured'));
    }
}
