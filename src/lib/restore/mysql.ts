import { exec } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { decompress } from '../targz';
import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

interface MysqlRestoreOptions extends BackItUpRestoreOptions {
    user: string;
    pass: string;
    host: string;
    port: number | string;
    dbName: string;
}

/**
 * Recreates the database and replays the dump into it.
 *
 * @param options connection settings; note that `pass` is quoted in place
 * @param fileNameMysql the unpacked .sql file
 * @param log restore logger
 * @param callback reports the mysql exit status
 */
function replayMySql(
    options: MysqlRestoreOptions,
    fileNameMysql: string,
    log: BackItUpRestoreLogger,
    callback?: BackItUpRestoreCallback,
): void {
    // NOTE: the second clause is missing the negation the pgsql version has, so a password already
    // wrapped in single quotes gets wrapped again. Kept as found - see also lib/scripts/30-mysql.
    if (
        (!options.pass.startsWith(`"`) || !options.pass.endsWith(`"`)) &&
        (!options.pass.startsWith(`'`) || options.pass.endsWith(`'`))
    ) {
        // Written back onto `options`, so a second call quotes the already quoted value again.
        options.pass = `"${options.pass}"`;
    }

    // create DB before executing script
    const cmdCreate = `mysql -u ${options.user} -p${options.pass} -h ${options.host} -P ${options.port} --execute='CREATE DATABASE IF NOT EXISTS ${options.dbName};'`;

    try {
        exec(cmdCreate, () => {
            const cmd = `mysql -u ${options.user} -p${options.pass} -h ${options.host} -P ${options.port} ${options.dbName} < ${fileNameMysql}`;

            try {
                // The original kept the ChildProcess in an unused `child` binding.
                exec(cmd, (error, stdout, stderr) => {
                    if (error) {
                        log.error(stderr);
                    }
                    callback?.(error);
                });
            } catch (e) {
                callback?.(e);
            }
        });
    } catch {
        // ignore errors
    }
}

export function restore(
    options: MysqlRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    adapter: ioBroker.Adapter,
    callback?: BackItUpRestoreCallback,
): void {
    let cb = callback;

    const fileNameMysql = join(options.backupDir, `mysql_restore_backupiobroker.sql`);
    log.debug('Start mysql Restore ...');

    // stop sql-Adapter before Restore
    let startAfterRestore = false;
    const enabledInstances: string[] = [];

    // Not awaited, so the instances may still be stopping when the replay starts. Kept as found.
    void adapter.getObjectView(
        'system',
        'instance',
        { startkey: 'system.adapter.sql.', endkey: 'system.adapter.sql.\u9999' },
        (err, instances) => {
            const resultInstances: { id: string; config: unknown }[] = [];
            if (!err && instances && instances.rows) {
                instances.rows.forEach(row => {
                    resultInstances.push({
                        id: row.id.replace('system.adapter.', ''),
                        config: row.value.native.type,
                    });
                });
                for (let i = 0; i < resultInstances.length; i++) {
                    const _id = resultInstances[i].id;
                    // Stop sql Instances
                    void adapter.getForeignObject(`system.adapter.${_id}`, (err, obj) => {
                        if (obj?.common?.enabled) {
                            void adapter.setForeignState(`system.adapter.${_id}.alive`, false);
                            log.debug(`${_id} is stopped`);
                            enabledInstances.push(_id);
                            startAfterRestore = true;
                        }
                    });
                }
            } else {
                log.debug('Could not retrieve sql instances!');
            }
        },
    );

    const timer = setInterval(() => {
        if (existsSync(fileNameMysql)) {
            const stats = statSync(fileNameMysql);
            const fileSize = Math.floor(stats.size / (1024 * 1024));
            log.debug(`Extract mysql Backupfile ${fileSize}MB so far...`);
        } else {
            log.debug(`Something is wrong with "${fileNameMysql}".`);
        }
    }, 10000);

    try {
        decompress(
            {
                src: fileName,
                dest: options.backupDir,
                tar: {
                    map: header => {
                        header.name = `mysql_restore_backupiobroker.sql`;
                        return header;
                    },
                },
            },
            // lib/targz only ever passes an error, so the `stderr` the original forwarded as the
            // exit code was always undefined.
            err => {
                clearInterval(timer);

                if (err) {
                    log.error(err);
                    if (cb) {
                        log.error('mysql Restore not completed');
                        cb(err);
                        cb = undefined;
                    }
                } else {
                    // The replay error is deliberately ignored - the step always reports success.
                    replayMySql(options, fileNameMysql, log, () => {
                        // Start sql Instances
                        if (startAfterRestore) {
                            enabledInstances.forEach(enabledInstance => {
                                void adapter.getForeignObject(
                                    `system.adapter.${enabledInstance}`,
                                    (err, obj) => {
                                        if (obj && !obj.common?.enabled) {
                                            void adapter.setForeignState(
                                                `system.adapter.${enabledInstance}.alive`,
                                                true,
                                            );
                                            log.debug(`${enabledInstance} started`);
                                        }
                                    },
                                );
                            });
                        }
                        // delete mysql file
                        if (existsSync(fileNameMysql)) {
                            try {
                                unlinkSync(fileNameMysql);
                            } catch {
                                log.debug(`${fileNameMysql} cannot deleted ...`);
                            }
                        }
                        if (cb) {
                            log.debug('mySql Restore completed successfully');
                            cb(null, 'mysql restore done');
                            cb = undefined;
                        }
                    });
                }
            },
        );
    } catch (err) {
        if (cb) {
            cb(err);
            cb = undefined;
        }
    }
}

export const isStop = false;
