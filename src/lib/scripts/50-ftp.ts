import { existsSync } from 'node:fs';
import Client from 'ftp';

import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface FtpUploadOptions {
    context: BackItUpExecuteContext;
    host: string;
    port?: number | string;
    user?: string;
    pass?: string;
    secure?: boolean;
    signedCertificates?: boolean;
    dir: string;
    deleteOldBackup?: boolean;
    advancedDelete?: boolean;
    deleteBackupAfter?: number;
    ftpDeleteAfter?: number;
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

function uploadFiles(
    client: Client,
    dir: string,
    fileNames: string[],
    log: ioBroker.Logger,
    errors: Errors,
    callback?: Done,
): void {
    if (!fileNames || !fileNames.length) {
        callback?.();
    } else {
        let fileName = fileNames.shift() as string;
        fileName = fileName.replace(/\\/g, '/');
        const onlyFileName = fileName.split('/').pop();

        log.debug(`Send ${onlyFileName}`);
        if (existsSync(fileName)) {
            client.put(fileName, `${dir}/${onlyFileName}`, err => {
                if (err) {
                    errors.ftp = err;
                    log.error(err as unknown as string);
                }
                setImmediate(uploadFiles, client, dir, fileNames, log, errors, callback);
            });
        } else {
            log.error(`File "${fileName}" not found`);
            setImmediate(uploadFiles, client, dir, fileNames, log, errors, callback);
        }
    }
}

function deleteFiles(client: Client, files: string[], log: ioBroker.Logger, errors: Errors, callback?: Done): void {
    if (!files || !files.length) {
        callback?.();
    } else {
        log.debug(`delete ${files[0]}`);
        const file = files.shift() as string;
        try {
            client.delete(file, err => {
                if (err) {
                    log.error(err as unknown as string);
                }
                setImmediate(deleteFiles, client, files, log, errors, callback);
            });
        } catch (e) {
            log.error(e);
            setImmediate(deleteFiles, client, files, log, errors, callback);
        }
    }
}

function cleanFiles(
    client: Client,
    options: FtpUploadOptions,
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
        if (dir[dir.length - 1] !== '/') {
            dir += '/';
        }
        client.list(dir, (err, result) => {
            if (err) {
                errors.ftp = errors.ftp || err;
            }
            if (names && result && result.length) {
                const files: string[] = [];
                names.forEach(name => {
                    if (name) {
                        let subResult;

                        try {
                            subResult = result.filter(a => a.name.startsWith(name));
                        } catch (e) {
                            log.error(`FTP error: ${e}`);
                        }
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

                        if (subResult && subResult.length > numDel) {
                            // delete oldest files
                            subResult.sort((a, b) => {
                                const at = new Date(a.date).getTime();
                                const bt = new Date(b.date).getTime();
                                if (at > bt) {
                                    return -1;
                                }
                                if (at < bt) {
                                    return 1;
                                }
                                return 0;
                            });

                            for (let i = numDel; i < subResult.length; i++) {
                                files.push(dir + subResult[i].name);
                            }
                        }
                    }
                });
                deleteFiles(client, files, log, errors, callback);
            } else {
                callback?.();
            }
        });
    } catch (e) {
        callback?.(e as Error);
    }
}

export function command(options: FtpUploadOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    if (options.host && options.context && options.context.fileNames && options.context.fileNames.length) {
        const client = new Client();
        const fileNames: string[] = JSON.parse(JSON.stringify(options.context.fileNames));

        // Note: this writes back onto the shared options object.
        if (!options.dir.startsWith('/')) {
            options.dir = `/${options.dir}`;
        }

        let dir = (options.dir || '').replace(/\\/g, '/');

        if (!dir || dir[0] !== '/') {
            dir = `/${dir || ''}`;
        }

        let cb = callback;

        client.on('ready', () => {
            log.debug('FTP connected.');
            uploadFiles(client, dir, fileNames, log, options.context.errors, () => {
                if (options.deleteOldBackup === true) {
                    const ftpDeleteAfter =
                        options.advancedDelete === false ? options.deleteBackupAfter : options.ftpDeleteAfter;

                    cleanFiles(
                        client,
                        options,
                        dir,
                        options.context.types,
                        ftpDeleteAfter as number,
                        log,
                        options.context.errors,
                        err => {
                            if (err) {
                                options.context.errors.ftp = options.context.errors.ftp || err;
                            } else {
                                options.context.done.push('ftp');
                            }
                            client.end();
                            if (cb) {
                                cb(err);
                                cb = undefined;
                            }
                        },
                    );
                } else {
                    client.end();
                    if (!options.context.errors.ftp) {
                        options.context.done.push('ftp');
                    }
                    cb?.();
                }
            });
        });

        client.on('error', err => {
            options.context.errors.ftp = err;
            if (cb) {
                cb(err);
                cb = undefined;
            }
        });

        client.connect({
            host: options.host,
            port: (options.port as number) || 21,
            secure: !!options.secure || false,
            // As in lib/list/ftp: `!!x || true` is always true, so the "allow only signed
            // certificates" setting has never had any effect here. Left as found - making the flag
            // work would silently switch off certificate checking for everyone who unticked it.
            secureOptions: { rejectUnauthorized: !!options.signedCertificates || true },
            user: options.user,
            password: options.pass,
        });
    } else {
        callback?.();
    }
}

export const ignoreErrors = true;
