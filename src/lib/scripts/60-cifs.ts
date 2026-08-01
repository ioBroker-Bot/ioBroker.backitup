import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { copyFile } from '../tools';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface CifsCopyOptions {
    context: BackItUpExecuteContext;
    dir: string;
    backupDir: string;
    mountType?: 'CIFS' | 'NFS' | 'Copy' | 'Expert';
    deleteOldBackup?: boolean;
    deleteBackupAfter?: number;
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

function copyFiles(dir: string, fileNames: string[], log: ioBroker.Logger, errors: Errors, callback?: Done): void {
    if (!fileNames || !fileNames.length) {
        callback?.();
    } else {
        let fileName = fileNames.shift() as string;
        fileName = fileName.replace(/\\/g, '/');
        const onlyFileName = fileName.split('/').pop() as string;
        try {
            log.debug(`Copy ${onlyFileName}...`);
            copyFile(fileName, join(dir, onlyFileName), err => {
                if (err) {
                    errors.cifs = err;
                    log.error(err as unknown as string);
                }
                setImmediate(copyFiles, dir, fileNames, log, errors, callback);
            });
        } catch (e) {
            log.error(e);
            errors.cifs = e as Error;
            setImmediate(copyFiles, dir, fileNames, log, errors, callback);
        }
    }
}

function deleteFiles(files: string[], log: ioBroker.Logger, errors: Errors): boolean | undefined {
    try {
        for (let f = 0; f < files.length; f++) {
            log.debug(`delete ${files[f]}`);
            unlinkSync(files[f]);
        }
        return true;
    } catch (e) {
        errors.cifs = errors.cifs || (e as Error);
        log.error(e);
        return undefined;
    }
}

function cleanFiles(
    dir: string,
    options: CifsCopyOptions,
    names: string[],
    num: number,
    log: ioBroker.Logger,
    errors: Errors,
): void {
    if (!num) {
        return;
    }

    try {
        if (dir[dir.length - 1] !== '/') {
            dir += '/';
        }

        const result = readdirSync(dir);

        if (result && result.length) {
            const files: string[] = [];
            names.forEach(name => {
                const subResult = result.filter(a => a.startsWith(name));
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
                    subResult.sort((a, b) => {
                        const at = statSync(dir + a).ctime;
                        const bt = statSync(dir + b).ctime;
                        if (at > bt) {
                            return -1;
                        }
                        if (at < bt) {
                            return 1;
                        }
                        return 0;
                    });

                    for (let i = numDel; i < subResult.length; i++) {
                        files.push(join(dir, subResult[i]));
                    }
                }
            });
            deleteFiles(files, log, errors);
        }
    } catch (e) {
        errors.cifs = errors.cifs || (e as Error);
    }
}

export function command(options: CifsCopyOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    if (options.dir && options.context && options.context.fileNames && options.context.fileNames.length) {
        const fileNames: string[] = JSON.parse(JSON.stringify(options.context.fileNames));

        let dir = options.dir.replace(/\\/g, '/');

        if (dir[0] !== '/' && !dir.match(/\w:/)) {
            dir = `/${dir || ''}`;
        }
        log.debug(`used copy path: ${dir}`);

        let cb = callback;

        if (existsSync(dir)) {
            if (dir === options.backupDir) {
                cb?.(`The storage path "${dir}" for copying is not configured correctly`);
            } else {
                copyFiles(dir, fileNames, log, options.context.errors, err => {
                    if (err) {
                        log.error(err as unknown as string);
                        options.context.errors.cifs = options.context.errors.cifs || err;
                    }
                    if (options.deleteOldBackup === true) {
                        // The original wraps this call in `if (…)` with its own TODO noting that
                        // cleanFiles returns nothing - so the condition is always false and 'cifs'
                        // is never recorded as done on this path. The dead branch is dropped here;
                        // the call and its effect are unchanged.
                        cleanFiles(
                            dir,
                            options,
                            options.context.types,
                            options.deleteBackupAfter as number,
                            log,
                            options.context.errors,
                        );
                    } else if (!options.context.errors.cifs) {
                        options.context.done.push('cifs');
                    }
                    if (cb) {
                        cb(err);
                        cb = undefined;
                    }
                });
            }
        } else if (options.mountType === 'Copy') {
            cb?.(`Path "${dir}" not found`);
        } else {
            cb?.();
        }
    } else {
        callback?.();
    }
}

export const ignoreErrors = true;
