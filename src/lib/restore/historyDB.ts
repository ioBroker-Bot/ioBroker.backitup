import { existsSync } from 'node:fs';

import { decompress } from '../targz';
import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

interface HistoryRestoreOptions extends BackItUpRestoreOptions {
    /** directory the history data is unpacked into */
    path: string;
}

export function restore(
    options: HistoryRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    adapter: ioBroker.Adapter,
    callback?: BackItUpRestoreCallback,
): void {
    let cb = callback;

    log.debug('Start History Restore ...');

    // stop history-Adapter before Restore
    let startAfterRestore = false;
    const enabledInstances: string[] = [];

    try {
        // Not awaited anywhere, so the instances may still be stopping when the unpacking starts.
        // Kept as found.
        adapter.getObjectView(
            'system',
            'instance',
            { startkey: 'system.adapter.history.', endkey: 'system.adapter.history.\u9999' },
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
                        // Stop history Instances
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
                    log.debug('Could not retrieve history instances!');
                }
            },
        );
    } catch {
        log.debug('Could not retrieve history instances!');
    }

    // Created through the adapter but cleared with the global clearInterval below. Kept as found.
    const timer = adapter.setInterval(() => {
        if (existsSync(options.path)) {
            log.debug('Extracting History Backup file...');
        } else {
            log.debug('Something is wrong. No file found.');
        }
    }, 10000);

    try {
        decompress(
            {
                src: fileName,
                dest: options.path,
            },
            // lib/targz only ever passes an error, so the `stderr` the original forwarded as the
            // exit code was always undefined.
            err => {
                clearInterval(timer as unknown as NodeJS.Timeout);

                if (err) {
                    log.error(err);
                    if (cb) {
                        log.error('History Restore not completed');
                        cb(err);
                        cb = undefined;
                    }
                } else {
                    if (cb) {
                        // Start history Instances
                        if (startAfterRestore) {
                            try {
                                enabledInstances.forEach(enabledInstance => {
                                    void adapter.getForeignObject(`system.adapter.${enabledInstance}`, (err, obj) => {
                                        if (obj && !obj.common?.enabled) {
                                            void adapter.setForeignState(
                                                `system.adapter.${enabledInstance}.alive`,
                                                true,
                                            );
                                            log.debug(`${enabledInstance} started`);
                                        }
                                    });
                                });
                            } catch {
                                log.debug(`History instance cannot be started`);
                            }
                        }
                        log.debug('History Restore completed successfully');
                        cb(null, 'historyDB restore done');
                        cb = undefined;
                    }
                }
            },
        );
    } catch (e) {
        if (cb) {
            cb(e);
            cb = undefined;
        }
    }
}

export const isStop = false;
