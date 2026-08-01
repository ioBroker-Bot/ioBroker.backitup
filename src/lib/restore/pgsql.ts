import { exec } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { decompress } from '../targz';
import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

interface PgsqlRestoreOptions extends BackItUpRestoreOptions {
    user: string;
    pass: string;
    host: string;
    port: number | string;
    dbName: string;
}

/**
 * Recreates the database and runs the restore command against it.
 *
 * @param options connection settings; note that `pass` is quoted in place
 * @param fileNamePgsql the unpacked .sql file
 * @param log restore logger
 * @param callback reports the command exit status
 */
function replayPgSql(
    options: PgsqlRestoreOptions,
    fileNamePgsql: string,
    log: BackItUpRestoreLogger,
    callback?: BackItUpRestoreCallback,
): void {
    if (
        (!options.pass.startsWith(`"`) || !options.pass.endsWith(`"`)) &&
        (!options.pass.startsWith(`'`) || !options.pass.endsWith(`'`))
    ) {
        // Written back onto `options`, so a second call quotes the already quoted value again.
        options.pass = `"${options.pass}"`;
    }

    // create DB before executing script  psql -c "create database Db name;" postgresql://iobroker:iobroker@localhost:5432/
    const cmdCreate = `psql -c "create database ${options.dbName};" postgresql://${options.user}:${options.pass}@${options.host}:${options.port}/`;
    try {
        exec(cmdCreate, () => {
            // NOTE: this runs `pg_dump`, not `pg_restore` - the commented-out pg_restore line the
            // original carried right here shows what was meant. As written the step writes a dump
            // to stdout and discards it, so nothing is actually restored. Kept as found.
            //const cmd = `pg_restore --dbname=postgresql://${options.user}:${options.pass}@${options.host}:${options.port}/${options.dbName} < ${fileNamePgsql}`;
            const cmd = `pg_dump --format=custom --dbname=postgresql://${options.user}:${options.pass}@${options.host}:${options.port}/${options.dbName} < ${fileNamePgsql}`;
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
    options: PgsqlRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    adapter: ioBroker.Adapter,
    callback?: BackItUpRestoreCallback,
): void {
    let cb = callback;

    const fileNamePgsql = join(options.backupDir, `pgsql_restore_backupiobroker.sql`);
    log.debug('Start postgresql Restore ...');

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
        if (existsSync(fileNamePgsql)) {
            const stats = statSync(fileNamePgsql);
            const fileSize = Math.floor(stats.size / (1024 * 1024));
            log.debug(`Extract postgresql Backup file ${fileSize}MB so far...`);
        } else {
            log.debug(`Something is wrong with "${fileNamePgsql}".`);
        }
    }, 10000);

    try {
        decompress(
            {
                src: fileName,
                dest: options.backupDir,
                tar: {
                    map: header => {
                        header.name = `pgsql_restore_backupiobroker.sql`;
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
                        log.error('postgresql Restore not completed');
                        cb(err);
                        cb = undefined;
                    }
                } else {
                    // The replay error is deliberately ignored - the step always reports success.
                    replayPgSql(options, fileNamePgsql, log, () => {
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
                        // Unlike mysql/sqlite this is not guarded, so a failing unlink throws out
                        // of the callback. Kept as found.
                        if (existsSync(fileNamePgsql)) {
                            unlinkSync(fileNamePgsql);
                        }
                        if (cb) {
                            log.debug('postgresql Restore completed successfully');
                            cb(null, 'postgresql restore done');
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
