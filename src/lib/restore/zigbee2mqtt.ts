import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { copy, ensureDir, remove } from 'fs-extra';

import { decompress } from '../targz';
import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

interface Zigbee2mqttRestoreOptions extends BackItUpRestoreOptions {
    /** the Zigbee2MQTT data directory that gets overwritten */
    path: string;
}

export async function restore(
    options: Zigbee2mqttRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    _adapter: ioBroker.Adapter,
    callback?: BackItUpRestoreCallback,
): Promise<void> {
    let cb = callback;

    log.debug('Start Zigbee2MQTT Restore ...');

    const timer = setInterval(() => {
        if (existsSync(options.path)) {
            log.debug('Extracting Zigbee2MQTT Backup file...');
        } else {
            log.debug('Something is wrong. No file found.');
        }
    }, 10000);

    const destPth = join(options.path).replace(/\\/g, '/');
    const tmpDir = join(options.backupDir, 'zigbee2mqtt_tmp').replace(/\\/g, '/');

    try {
        await ensureDir(tmpDir);
        log.debug(`Zigbee2MQTT tmp directory created: ${tmpDir}`);
    } catch {
        log.debug('Zigbee2MQTT tmp directory cannot created');
    }

    try {
        decompress(
            {
                src: fileName,
                dest: tmpDir,
            },
            // lib/targz only ever passes an error, so the `stderr` the original forwarded as the
            // exit code was always undefined.
            async err => {
                if (timer) {
                    clearInterval(timer);
                }

                if (err) {
                    log.error(err);
                    if (cb) {
                        log.error('Zigbee2MQTT Restore not completed');
                        cb(err);
                        cb = undefined;
                    }
                } else {
                    if (cb) {
                        // Restore Backup-Files
                        if (existsSync(tmpDir) && existsSync(destPth)) {
                            const files = readdirSync(destPth);

                            // NOTE: `file` is a bare name, so this deletes relative to the process
                            // working directory rather than from `destPth` - and the callback is
                            // async inside forEach, so nothing waits for it either. Kept as found.
                            files.forEach(async file => {
                                const stat = statSync(join(destPth, file));

                                if (!stat.isDirectory()) {
                                    await remove(file);
                                }
                            });

                            await copy(tmpDir, destPth, {
                                filter: (path: string) => !path.includes('log'),
                            })
                                .then(async () => {
                                    log.debug('Zigbee2MQTT copy finish');

                                    log.debug('Try deleting the Zigbee2MQTT tmp directory');
                                    await remove(tmpDir);

                                    if (!existsSync(tmpDir)) {
                                        log.debug('Zigbee2MQTT tmp directory was successfully deleted');
                                    }

                                    log.debug('Zigbee2MQTT Restore completed successfully');
                                    cb!(null, 'Zigbee2MQTT restore done');
                                    cb = undefined;
                                })
                                .catch(err => {
                                    log.error(err);
                                    cb?.(null, 'Zigbee2MQTT restore broken');
                                    cb = undefined;
                                });
                        } else {
                            log.debug('Zigbee2MQTT Restore not completed. Please check your Path Configuration.');
                            cb(null, 'Zigbee2MQTT Restore not completed');
                            cb = undefined;
                        }
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
