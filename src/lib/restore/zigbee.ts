import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { copySync, emptyDirSync, ensureDirSync, removeSync } from 'fs-extra';

import { decompress } from '../targz';
import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

interface ZigbeeRestoreOptions extends BackItUpRestoreOptions {
    /** parent directory holding the per-instance zigbee_<n> directories */
    path: string;
}

/** Module level, so a second restore overwrites the handle of the first. Kept as found. */
let waitRestore: NodeJS.Timeout | undefined;

export function restore(
    options: ZigbeeRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    adapter: ioBroker.Adapter,
    callback?: BackItUpRestoreCallback,
): void {
    let cb = callback;

    log.debug('Start Zigbee Restore ...');

    const instance = fileName.split('.');
    const num = instance[1].split('_');

    const tmpDir = join(options.backupDir, `zigbee_${num[0]}`).replace(/\\/g, '/');
    const zigbeePth = join(options.path, `zigbee_${num[0]}`).replace(/\\/g, '/');

    log.debug(`Filename for Restore: ${fileName}`);

    // A string, so fs-extra reads no mode from it and falls back to the default. Kept as found.
    const desiredMode = '0o2775';

    try {
        ensureDirSync(tmpDir, desiredMode as unknown as number);
        log.debug(`zigbee tmp directory created: ${tmpDir}`);
    } catch {
        log.debug('zigbee tmp directory cannot created');
    }

    if (existsSync(zigbeePth)) {
        try {
            emptyDirSync(zigbeePth);
            if (!readdirSync(zigbeePth).length) {
                log.debug('old Zigbee database was successfully deleted');
            }
        } catch {
            log.debug('old Zigbee database cannot deleted');
        }
    }
    // Stop zigbee - not awaited, so the 3s delay below is what the unpacking relies on.
    let startAfterRestore = false;
    void adapter.getForeignObject(`system.adapter.zigbee.${num[0]}`, (err, obj) => {
        if (obj?.common?.enabled) {
            void adapter.setForeignState(`system.adapter.zigbee.${num[0]}.alive`, false);
            log.debug(`zigbee.${num[0]} stopped`);
            startAfterRestore = true;
        }
    });

    try {
        waitRestore = setTimeout(
            () =>
                decompress(
                    {
                        src: fileName,
                        dest: tmpDir,
                    },
                    // lib/targz only ever passes an error, so the `stderr` the original forwarded
                    // as the exit code was always undefined.
                    err => {
                        if (err) {
                            log.error('Zigbee Restore not completed');
                            log.error(err);
                            if (cb) {
                                cb(err);
                                clearTimeout(waitRestore);
                            }
                        } else {
                            if (cb) {
                                try {
                                    copySync(tmpDir, zigbeePth);
                                    if (existsSync(zigbeePth)) {
                                        log.debug('Zigbee Database is successfully restored');
                                    }
                                    log.debug('Try deleting the Zigbee tmp directory');
                                    removeSync(tmpDir);
                                    if (!existsSync(tmpDir)) {
                                        log.debug('Zigbee tmp directory was successfully deleted');
                                    }
                                    // Start zigbee
                                    if (startAfterRestore) {
                                        void adapter.getForeignObject(
                                            `system.adapter.zigbee.${num[0]}`,
                                            (err, obj) => {
                                                if (obj && !obj.common?.enabled) {
                                                    void adapter.setForeignState(
                                                        `system.adapter.zigbee.${num[0]}.alive`,
                                                        true,
                                                    );
                                                    log.debug(`zigbee.${num[0]} started`);
                                                }
                                            },
                                        );
                                    }
                                } catch (err) {
                                    // Does not return, so the success callback below still fires
                                    // afterwards and the step reports twice. Kept as found.
                                    cb?.(err);
                                    clearTimeout(waitRestore);
                                }
                                log.debug('Zigbee Restore completed successfully');
                                cb?.(null, 'zigbee database restore done');
                                cb = undefined;
                                clearTimeout(waitRestore);
                            }
                        }
                    },
                ),
            3000,
        );
    } catch (e) {
        if (cb) {
            cb(e);
            cb = undefined;
            clearTimeout(waitRestore);
        }
    }
}

export const isStop = false;
