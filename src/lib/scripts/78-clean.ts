import { join } from 'node:path';
import { lstatSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { removeSync } from 'fs-extra';

import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface CleanOptions {
    context: BackItUpExecuteContext;
    backupDir: string;
    /** keep this many files per backup type; 0 means "manual run, delete nothing" */
    deleteBackupAfter: number;
    name?: string;
    ignoreErrors?: boolean;
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

function cleanFiles(
    dir: string,
    options: CleanOptions,
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
        names.forEach(name => {
            let result = readdirSync(dir);

            if (result && result.length && num) {
                result = result.filter(a => a.startsWith(name));
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

                const files: string[] = [];

                if (result.length > numDel) {
                    // delete oldies files
                    result.sort((a, b) => {
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

                    for (let i = numDel; i < result.length; i++) {
                        files.push(join(dir, result[i]));
                    }
                }
                deleteFiles(files, log, errors);
            }
        });
    } catch (e) {
        errors.cifs = errors.cifs || (e as Error);
    }
}

function deleteFiles(files: string[], log: ioBroker.Logger, errors: Errors): boolean | undefined {
    try {
        for (let f = 0; f < files.length; f++) {
            log.debug(`delete ${files[f]}`);

            const stat = lstatSync(files[f]);
            if (stat.isDirectory()) {
                removeSync(files[f]);
            } else {
                unlinkSync(files[f]);
            }
        }
        return true;
    } catch (e) {
        errors.clean = errors.clean || (e as Error);
        log.error(e);
        return undefined;
    }
}

export function command(options: CleanOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    if (options.backupDir && options.context && options.context.fileNames && options.context.fileNames.length) {
        // delete files only if no errors
        const errors = Object.keys(options.context.errors);

        if (!errors.length) {
            // may be make it configurable
            let dir = options.backupDir.replace(/\\/g, '/');

            if (dir[0] !== '/' && !dir.match(/\w:/)) {
                dir = `/${dir || ''}`;
            }

            if (options && options.deleteBackupAfter === 0) {
                log.warn('No older backup files are deleted, because this backup was started manually');
            }

            // `cleanFiles` is synchronous and takes six parameters. A seventh argument - a
            // completion callback - used to be passed here and was silently dropped, so the error
            // handling it contained never ran. Removed rather than wired up: making it fire would
            // change when and with what this step reports back.
            cleanFiles(
                dir,
                options,
                options.context.types,
                options.deleteBackupAfter,
                log,
                options.context.errors,
            );
        } else {
            log.error(`Backup files not deleted from ${options.backupDir} because some errors.`);
        }
    }

    callback?.();
}

export const ignoreErrors = true;
