import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copy, ensureDir, remove } from 'fs-extra';

import { decompress } from '../targz';
import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

interface JarvisRestoreOptions extends BackItUpRestoreOptions {
    /** directory holding the "jarvis" data directory */
    path: string;
}

/** One entry of the states.json the backup carries */
interface JarvisStateEntry {
    id: string;
    value: ioBroker.StateValue;
}

export async function restore(
    options: JarvisRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    adapter: ioBroker.Adapter,
    callback?: BackItUpRestoreCallback,
): Promise<void> {
    let cb = callback;

    log.debug('Start Jarvis Restore ...');

    const instance = fileName.split('.');
    const num = instance[1].split('_');

    const tmpDir = join(options.backupDir, `jarvis_${num[0]}`).replace(/\\/g, '/');
    const stateDir = join(tmpDir, 'states').replace(/\\/g, '/');

    log.debug(`filename for restore: ${fileName}`);

    // Stop jarvis
    let startAfterRestore = false;

    const obj = await adapter.getForeignObjectAsync(`system.adapter.jarvis.${num[0]}`);

    if (obj?.common?.enabled) {
        await adapter.setForeignStateAsync(`system.adapter.jarvis.${num[0]}.alive`, false);
        log.debug(`jarvis.${num[0]} stopped`);
        startAfterRestore = true;
    }

    try {
        await ensureDir(tmpDir);
        log.debug(`jarvis tmp directory created: ${tmpDir}`);
    } catch {
        log.debug('jarvis tmp directory cannot created');
    }

    const pthJarvis = join(options.path, 'jarvis');
    const pth = join(pthJarvis, num[0]);

    if (existsSync(pth)) {
        try {
            await remove(pth);
            if (!existsSync(pth)) {
                log.debug('old jarvis database directory was successfully deleted');
            }
        } catch {
            log.debug('old jarvis database directory cannot deleted');
        }
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
                if (err) {
                    log.error('jarvis restore not completed');
                    log.error(err);
                    if (cb) {
                        cb(err);
                        cb = undefined;
                    }
                } else {
                    if (cb) {
                        try {
                            // Restore States
                            const object = await readFile(join(stateDir, 'states.json'));

                            if (object) {
                                const jarvisObjects: JarvisStateEntry[] = JSON.parse(object.toString());

                                // for-in, not for-of: it also visits whatever a non-array
                                // states.json deserialises to. Kept as found.
                                // eslint-disable-next-line @typescript-eslint/no-for-in-array
                                for (const i in jarvisObjects) {
                                    let _object;
                                    try {
                                        _object = await adapter.getForeignObjectAsync(jarvisObjects[i].id);
                                    } catch (err) {
                                        log.debug(err);
                                    }
                                    if (_object) {
                                        try {
                                            if (jarvisObjects[i].value !== null) {
                                                await adapter.setForeignStateAsync(
                                                    jarvisObjects[i].id,
                                                    jarvisObjects[i].value,
                                                    true,
                                                );
                                            }
                                        } catch (err) {
                                            log.debug(`Error on set Object: ${err}`);
                                        }
                                    }
                                }
                            }

                            log.debug('Try deleting the states tmp directory');
                            await remove(stateDir);
                            if (!existsSync(stateDir)) {
                                log.debug('states tmp directory was successfully deleted');
                            }

                            // Restore Backup-Files
                            await copy(tmpDir, pth);
                            if (existsSync(pth)) {
                                log.debug('jarvis database is successfully restored');
                            }
                            // Start jarvis
                            if (startAfterRestore) {
                                const obj = await adapter.getForeignObjectAsync(
                                    `system.adapter.jarvis.${num[0]}`,
                                );

                                if (obj && !obj.common?.enabled) {
                                    await adapter.setForeignStateAsync(
                                        `system.adapter.jarvis.${num[0]}.alive`,
                                        true,
                                    );
                                    log.debug(`jarvis.${num[0]} started`);
                                }
                            }
                            log.debug('Try deleting the jarvis tmp directory');
                            await remove(tmpDir);
                            if (!existsSync(tmpDir)) {
                                log.debug('jarvis tmp directory was successfully deleted');
                            }
                        } catch (err) {
                            // Unlike zigbee/esphome/yahka this clears the callback, so the success
                            // report below is skipped - only the "completed successfully" line
                            // still gets logged.
                            cb?.(err);
                            cb = undefined;
                        }
                        log.debug('jarvis Restore completed successfully');
                        cb?.(null, 'jarvis database restore done');
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
