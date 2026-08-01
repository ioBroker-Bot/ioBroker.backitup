import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { copySync, emptyDirSync, ensureDirSync, removeSync } from 'fs-extra';

import { decompress } from '../targz';
import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

interface EsphomeRestoreOptions extends BackItUpRestoreOptions {
    /** parent directory holding the per-instance esphome.<n> directories */
    path: string;
}

/** Module level, so a second restore overwrites the handle of the first. Kept as found. */
let waitRestore: NodeJS.Timeout | undefined;

export function restore(
    options: EsphomeRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    adapter: ioBroker.Adapter,
    callback?: BackItUpRestoreCallback,
): void {
    let cb = callback;

    log.debug('Start ESPHome Restore ...');

    // NOTE: unlike zigbee.js this splits on '.' twice, so `num[0]` keeps everything up to the next
    // dot rather than just the instance number. Kept as found.
    const instance = fileName.split('.');
    const num = instance[1].split('.');

    const tmpDir = join(options.backupDir, `esphome.${num[0]}`).replace(/\\/g, '/');
    const esphomePth = join(options.path, `esphome.${num[0]}`).replace(/\\/g, '/');

    log.debug(`Filename for Restore: ${fileName}`);

    // A string, so fs-extra reads no mode from it and falls back to the default. Kept as found.
    const desiredMode = '0o2775';

    try {
        ensureDirSync(tmpDir, desiredMode as unknown as number);
        log.debug(`esphome tmp directory created: ${tmpDir}`);
    } catch {
        log.debug('esphome tmp directory cannot created');
    }

    if (existsSync(esphomePth)) {
        try {
            emptyDirSync(esphomePth);
            if (!readdirSync(esphomePth).length) {
                log.debug('old ESPHome data was successfully deleted');
            }
        } catch {
            log.debug('old ESPHome data cannot deleted');
        }
    }
    // Stop esphome - not awaited, so the 3s delay below is what the unpacking relies on.
    let startAfterRestore = false;
    void adapter.getForeignObject(`system.adapter.esphome.${num[0]}`, (err, obj) => {
        if (obj?.common?.enabled) {
            void adapter.setForeignState(`system.adapter.esphome.${num[0]}.alive`, false);
            log.debug(`esphome.${num[0]} stopped`);
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
                            log.error('ESPHome Restore not completed');
                            log.error(err);
                            if (cb) {
                                cb(err);
                                clearTimeout(waitRestore);
                            }
                        } else {
                            if (cb) {
                                try {
                                    copySync(tmpDir, esphomePth);
                                    if (existsSync(esphomePth)) {
                                        log.debug('ESPHome data is successfully restored');
                                    }
                                    log.debug('Try deleting the esphome tmp directory');
                                    removeSync(tmpDir);
                                    if (!existsSync(tmpDir)) {
                                        log.debug('esphome tmp directory was successfully deleted');
                                    }
                                    // Start esphome
                                    if (startAfterRestore) {
                                        void adapter.getForeignObject(
                                            `system.adapter.esphome.${num[0]}`,
                                            (err, obj) => {
                                                if (obj && !obj.common?.enabled) {
                                                    void adapter.setForeignState(
                                                        `system.adapter.esphome.${num[0]}.alive`,
                                                        true,
                                                    );
                                                    log.debug(`esphome.${num[0]} started`);
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
                                log.debug('esphome Restore completed successfully');
                                cb?.(null, 'ESPHome data restore done');
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
