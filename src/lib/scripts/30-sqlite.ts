import { exec } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { getDate } from '../tools';
import { compress } from '../targz';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface SqliteOptions {
    context: BackItUpExecuteContext;
    adapter: ioBroker.Adapter;
    backupDir: string;
    /** path to the sqlite database file */
    filePth: string;
    /** path to the sqlite3 binary; falls back to `sqlite3` from PATH */
    exe?: string;
    hostType?: 'Single' | 'Master' | 'Slave';
    slaveSuffix?: string;
    nameSuffix?: string;
}

export async function command(
    options: SqliteOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    log.debug('Start SQLite3 Backup ...');

    // stop sql-Adapter before Backup
    let startAfterBackup = false;
    const enabledInstances: string[] = [];
    const resultInstances: { id: string; config: string }[] = [];

    let cb = callback;

    const instances = await options.adapter
        .getObjectViewAsync('system', 'instance', {
            startkey: 'system.adapter.sql.',
            // U+9999 is the sentinel upper bound the ioBroker object views use, not a real character
            endkey: 'system.adapter.sql.香',
        })
        .catch(err => log.error(err));

    if (instances && instances.rows) {
        instances.rows.forEach(row =>
            resultInstances.push({
                id: row.id.replace('system.adapter.', ''),
                config: row.value.native.type,
            }),
        );

        for (let i = 0; i < resultInstances.length; i++) {
            const _id = resultInstances[i].id;
            const obj = await options.adapter
                .getForeignObjectAsync(`system.adapter.${_id}`)
                .catch(err => log.error(err));

            if (obj?.common?.enabled) {
                await options.adapter
                    .setForeignStateAsync(`system.adapter.${_id}.alive`, false)
                    .then(() => log.debug(`${_id} is stopped`))
                    .catch(err => log.error(err));

                enabledInstances.push(_id);
                startAfterBackup = true;
            }
        }
    } else {
        log.warn('Could not retrieve sql instances!');
    }

    const nameSuffix =
        options.hostType === 'Slave' && options.slaveSuffix
            ? options.slaveSuffix
            : options.hostType !== 'Slave' && options.nameSuffix
              ? options.nameSuffix
              : '';
    const fileName = join(
        options.backupDir,
        `sqlite_${getDate()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`,
    );
    const fileNameSQlite = join(options.backupDir, `sqlite_${getDate()}_backupiobroker.sql`);

    options.context.fileNames.push(fileName);

    const timer = setInterval(() => {
        if (existsSync(fileName)) {
            const stats = statSync(fileName);
            const fileSize = Math.floor(stats.size / (1024 * 1024));
            log.debug(`Packed ${fileSize}MB so far...`);
        }
    }, 10000);

    try {
        exec(`${options.exe ? options.exe : 'sqlite3'} ${options.filePth} .dump > ${fileNameSQlite}`, error => {
            if (error) {
                clearInterval(timer);
                // `ExecException` is declared as Omit<ErrnoException, 'code'>, which drops the
                // nominal Error identity; binding it back keeps toString() and the log identical.
                const failure: Error = error;
                options.context.errors.sqlite = failure.toString();
                log.error(failure as unknown as string);
                // Note: not cleared here, so a later call is still possible.
                cb?.(error);
            } else {
                compress(
                    {
                        src: fileNameSQlite,
                        dest: fileName,
                        tar: {
                            map: header => {
                                header.name = fileNameSQlite.split('/').pop() as string;
                                return header;
                            },
                        },
                    },
                    // lib/targz only ever passes an error; the stdout/stderr parameters the original
                    // declared here were always undefined.
                    async err => {
                        clearInterval(timer);
                        if (err) {
                            options.context.errors.sqlite = err.toString();
                            cb?.(err);
                        } else {
                            // Start sql Instances
                            if (startAfterBackup) {
                                for (let i = 0; i < enabledInstances.length; i++) {
                                    await options.adapter
                                        .setForeignStateAsync(`system.adapter.${enabledInstances[i]}.alive`, true)
                                        .then(() => log.debug(`${enabledInstances[i]} started`))
                                        .catch(e => log.error(`${enabledInstances[i]} not started: ${e}`));
                                }
                            }

                            log.debug(`Backup created: ${fileName}`);
                            options.context.done.push('sqlite');
                            options.context.types.push('sqlite');

                            if (existsSync(fileNameSQlite)) {
                                try {
                                    await unlink(fileNameSQlite);
                                    log.debug('sqlite File deleted!');
                                } catch (e) {
                                    log.warn(`sqlite File cannot deleted: ${e}`);
                                    // Reports the compress error, which is falsy in this branch -
                                    // so this is an extra call with no error, and the success call
                                    // below still follows. Kept as found.
                                    cb?.(err);
                                }
                            }

                            if (cb) {
                                cb(null);
                                cb = undefined;
                            }
                        }
                    },
                );
            }
        });
    } catch (err) {
        clearInterval(timer);
        cb?.(err as Error);
        cb = undefined;
    }
}

export const ignoreErrors = true;
