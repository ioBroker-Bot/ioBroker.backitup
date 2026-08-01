import { exec } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { decompress } from '../targz';
import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

interface SqliteRestoreOptions extends BackItUpRestoreOptions {
    /** the .db file that gets replaced */
    filePth?: string;
    /** path to the sqlite3 binary; falls back to the one on PATH */
    exe?: string;
}

/**
 * Deletes the old database file and feeds the dump into a fresh one.
 *
 * @param options sqlite settings
 * @param fileNameSQlite the unpacked .sql file
 * @param log restore logger
 * @param callback reports the sqlite3 exit status
 */
function replaySqlite(
    options: SqliteRestoreOptions,
    fileNameSQlite: string,
    log: BackItUpRestoreLogger,
    callback?: BackItUpRestoreCallback,
): void {
    if (options?.filePth && existsSync(options.filePth)) {
        try {
            unlinkSync(options.filePth);
            log.debug('old sqlite db deleted!');
        } catch (e) {
            // Reports the failure but does not return, so the restore below runs anyway and the
            // callback fires a second time. Kept as found.
            log.debug(`sqlite db cannot deleted: ${e}`);
            callback?.(e);
        }
    }

    const cmdRestore = `${options.exe ? options.exe : 'sqlite3'} ${options.filePth} < ${fileNameSQlite}`;

    try {
        exec(cmdRestore, (error, stdout, stderr) => {
            if (error) {
                log.error(stderr);
            }
            callback?.(error);
        });
    } catch {
        // ignore errors
    }
}

export function restore(
    options: SqliteRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    adapter: ioBroker.Adapter,
    callback?: BackItUpRestoreCallback,
): void {
    let cb = callback;

    const fileNameSQlite = join(options.backupDir, `sqlite_restore_backupiobroker.sql`);
    log.debug('Start sqlite Restore ...');

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
        if (existsSync(fileNameSQlite)) {
            const stats = statSync(fileNameSQlite);
            const fileSize = Math.floor(stats.size / (1024 * 1024));
            log.debug(`Extract sqlite Backup file ${fileSize}MB so far...`);
        } else {
            log.debug(`Something is wrong with "${fileNameSQlite}".`);
        }
    }, 10000);

    try {
        decompress(
            {
                src: fileName,
                dest: options.backupDir,
                tar: {
                    map: header => {
                        header.name = `sqlite_restore_backupiobroker.sql`;
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
                        log.error('sqlite Restore not completed');
                        cb(err);
                        cb = undefined;
                    }
                } else {
                    // The replay error is deliberately ignored - the step always reports success.
                    replaySqlite(options, fileNameSQlite, log, () => {
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
                        // delete sqlite file
                        if (existsSync(fileNameSQlite)) {
                            try {
                                unlinkSync(fileNameSQlite);
                            } catch {
                                log.debug(`${fileNameSQlite} cannot deleted ...`);
                            }
                        }
                        if (cb) {
                            log.debug('sqlite Restore completed successfully');
                            cb(null, 'sqlite restore done');
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
