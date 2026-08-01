import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { authenticate } from 'dropbox-v2-api';

import Dropbox from '../dropboxLib';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

type DropboxClient = ReturnType<typeof authenticate>;

interface DropboxUploadOptions {
    context: BackItUpExecuteContext;
    accessToken?: string;
    dir: string;
    deleteOldBackup?: boolean;
    advancedDelete?: boolean;
    deleteBackupAfter?: number;
    dropboxDeleteAfter?: number;
    influxDBMulti?: boolean;
    influxDBEvents?: unknown[];
    mySqlMulti?: boolean;
    mySqlEvents?: unknown[];
    pgSqlMulti?: boolean;
    pgSqlEvents?: unknown[];
    ccuMulti?: boolean;
    ccuEvents?: unknown[];
}

type Errors = BackItUpExecuteContext['errors'];
type Done = (error?: Error | string | null) => void;

/** Files above this size go through a chunked upload session */
const SINGLE_SHOT_LIMIT_MB = 100;

async function copyFiles(
    dbx: DropboxClient,
    dropbox: Dropbox,
    dir: string,
    fileNames: string[],
    log: ioBroker.Logger,
    errors: Errors,
    callback?: Done,
): Promise<void> {
    if (!fileNames || !fileNames.length) {
        callback?.();
    } else {
        let fileName;
        try {
            fileName = fileNames.shift() as string;
            fileName = fileName.replace(/\\/g, '/');
            const onlyFileName = fileName.split('/').pop() as string;

            if (existsSync(fileName)) {
                log.debug(`Dropbox: Copy ${onlyFileName}...`);
                const fileSize = statSync(fileName).size;

                if (fileSize && Math.round((fileSize / (1024 * 1024)) * 10) / 10 <= SINGLE_SHOT_LIMIT_MB) {
                    const readStream = createReadStream(fileName);
                    readStream.on('error', err => {
                        log.error(`readStream Dropbox: ${err}`);
                    });
                    dbx(
                        {
                            resource: 'files/upload',
                            parameters: {
                                path: join(dir, onlyFileName).replace(/\\/g, '/'),
                            },
                            readStream,
                        },
                        err => {
                            try {
                                if (err) {
                                    errors.dropbox = JSON.stringify(err);
                                    log.error(`upload Dropbox: ${JSON.stringify(err)}`);
                                }
                                setImmediate(copyFiles, dbx, dropbox, dir, fileNames, log, errors, callback);
                            } catch (e) {
                                errors.dropbox = e as Error;
                                log.error(`Dropbox callback error: ${JSON.stringify(e)}`);
                                setImmediate(copyFiles, dbx, dropbox, dir, fileNames, log, errors, callback);
                            }
                        },
                    );
                } else if (fileSize && Math.round((fileSize / (1024 * 1024)) * 10) / 10 > SINGLE_SHOT_LIMIT_MB) {
                    try {
                        await dropbox.sessionUpload(dbx, fileName, dir, log);
                    } catch (e) {
                        errors.dropbox = e as Error;
                        log.error(`Dropbox sessionUpload: ${JSON.stringify(e)}`);
                    }
                    setImmediate(copyFiles, dbx, dropbox, dir, fileNames, log, errors, callback);
                }
                // Note: a zero-byte file matches neither branch, so the walk stops there.
            } else {
                log.error(`Dropbox: File "${fileName}" not found`);
                setImmediate(copyFiles, dbx, dropbox, dir, fileNames, log, errors, callback);
            }
        } catch (e) {
            errors.dropbox = e as Error;
            log.error(`Dropbox: ${JSON.stringify(e)}`);
            setImmediate(copyFiles, dbx, dropbox, dir, fileNames, log, errors, callback);
        }
    }
}

function deleteFiles(
    dbx: DropboxClient,
    files: string[],
    log: ioBroker.Logger,
    errors: Errors,
    callback?: Done,
): void {
    if (!files || !files.length) {
        callback?.();
    } else {
        log.debug(`Dropbox: delete ${files[0]}`);
        try {
            dbx(
                {
                    resource: 'files/delete',
                    parameters: {
                        path: files.shift(),
                    },
                },
                err => {
                    if (err) {
                        log.error(`Dropbox: ${JSON.stringify(err)}`);
                    }
                    setImmediate(deleteFiles, dbx, files, log, errors, callback);
                },
            );
        } catch (e) {
            log.error(`Dropbox: ${JSON.stringify(e)}`);
            // Reports completion and then keeps walking the list - kept as found.
            callback?.();
            setImmediate(deleteFiles, dbx, files, log, errors, callback);
        }
    }
}

function cleanFiles(
    dbx: DropboxClient,
    options: DropboxUploadOptions,
    dir: string,
    names: string[],
    num: number,
    log: ioBroker.Logger,
    errors: Errors,
    callback?: Done,
): void {
    if (!num) {
        callback?.();
        return;
    }
    try {
        dbx(
            {
                resource: 'files/list_folder',
                parameters: {
                    path: dir.replace(/^\/$/, ''),
                },
            },
            (err, result) => {
                if (err) {
                    log.error(`Dropbox: ${JSON.stringify(err)}`);
                }

                if (result && result.entries) {
                    const files: string[] = [];
                    names.forEach(name => {
                        const subResult = (result.entries as any[]).filter((a: any) => a.name.startsWith(name));
                        let numDel = num;

                        // Multi-instance setups produce one file per configured target per run.
                        if (name === 'influxDB' && options.influxDBMulti) {
                            numDel = num * (options.influxDBEvents as unknown[]).length;
                        }
                        if (name === 'mysql' && options.mySqlMulti) {
                            numDel = num * (options.mySqlEvents as unknown[]).length;
                        }
                        if (name === 'pgsql' && options.pgSqlMulti) {
                            numDel = num * (options.pgSqlEvents as unknown[]).length;
                        }
                        if (name === 'homematic' && options.ccuMulti) {
                            numDel = num * (options.ccuEvents as unknown[]).length;
                        }

                        if (subResult.length > numDel) {
                            // delete oldest files
                            subResult.sort((a: any, b: any) => {
                                const at = new Date(a.client_modified).getTime();
                                const bt = new Date(b.client_modified).getTime();
                                if (at > bt) {
                                    return -1;
                                }
                                if (at < bt) {
                                    return 1;
                                }
                                return 0;
                            });

                            for (let i = numDel; i < subResult.length; i++) {
                                files.push(subResult[i].path_display);
                            }
                        }
                    });
                    deleteFiles(dbx, files, log, errors, callback);
                } else {
                    callback?.();
                }
            },
        );
    } catch (e) {
        callback?.(e as Error);
    }
}

export async function command(
    options: DropboxUploadOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    const dropbox = new Dropbox();

    // Token refresh
    const db_accessToken = options.accessToken || '';

    if (db_accessToken && options.context.fileNames.length) {
        const fileNames: string[] = JSON.parse(JSON.stringify(options.context.fileNames));
        const dbx = authenticate({ token: db_accessToken });

        let dir = (options.dir || '').replace(/\\/g, '/');

        if (!dir || dir[0] !== '/') {
            dir = `/${dir || ''}`;
        }

        void copyFiles(dbx, dropbox, dir, fileNames, log, options.context.errors, err => {
            if (err) {
                options.context.errors.dropbox = err;
                log.error(`Dropbox: ${JSON.stringify(err)}`);
            }
            if (options.deleteOldBackup === true) {
                const dropboxDeleteAfter =
                    options.advancedDelete === false ? options.deleteBackupAfter : options.dropboxDeleteAfter;

                cleanFiles(
                    dbx,
                    options,
                    dir,
                    options.context.types,
                    dropboxDeleteAfter as number,
                    log,
                    options.context.errors,
                    cleanErr => {
                        if (cleanErr) {
                            options.context.errors.dropbox = options.context.errors.dropbox || cleanErr;
                        } else if (!options.context.errors.dropbox) {
                            options.context.done.push('dropbox');
                        }
                        callback?.(cleanErr);
                    },
                );
            } else {
                if (!options.context.errors.dropbox) {
                    options.context.done.push('dropbox');
                }
                callback?.(err);
            }
        });
    } else {
        callback?.();
    }
}

export const ignoreErrors = true;
