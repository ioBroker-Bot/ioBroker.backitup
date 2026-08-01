import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { copySync, emptyDirSync, ensureDirSync, removeSync } from 'fs-extra';

import { decompress } from '../targz';
import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

interface YahkaRestoreOptions extends BackItUpRestoreOptions {
    /** parent directory holding the per-instance yahka.<n>.hapdata directories */
    path: string;
}

/** Module level, so a second restore overwrites the handle of the first. Kept as found. */
let waitRestore: NodeJS.Timeout | undefined;

export function restore(
    options: YahkaRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    adapter: ioBroker.Adapter,
    callback?: BackItUpRestoreCallback,
): void {
    let cb = callback;

    log.debug('Start Yahka Restore ...');

    const instance = fileName.split('.');
    const num = instance[1].split('_');

    const tmpDir = join(options.backupDir, `yahka_${num[0]}.hapdata`).replace(/\\/g, '/');
    log.debug(`Filename for Restore: ${fileName}`);

    // A string, so fs-extra reads no mode from it and falls back to the default. Kept as found.
    const desiredMode = '0o2775';

    try {
        ensureDirSync(tmpDir, desiredMode as unknown as number);
        log.debug(`yahka tmp directory created: ${tmpDir}`);
    } catch {
        log.debug('yahka tmp directory cannot created');
    }

    if (existsSync(`${options.path}/yahka.${num[0]}.hapdata`)) {
        try {
            removeSync(`${options.path}/yahka.${num[0]}.hapdata`);
            if (!existsSync(`${options.path}/yahka.${num[0]}.hapdata`)) {
                log.debug('old Yahka database directory was successfully deleted');
            }
        } catch {
            log.debug('old Yahka database directory cannot deleted');
        }
    }
    // Stop yahka - not awaited, so the 3s delay below is what the unpacking relies on.
    let startAfterRestore = false;
    void adapter.getForeignObject(`system.adapter.yahka.${num[0]}`, (err, obj) => {
        if (obj?.common?.enabled) {
            void adapter.setForeignState(`system.adapter.yahka.${num[0]}.alive`, false);
            log.debug(`yahka.${num[0]} stopped`);
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
                            log.error('Yahka Restore not completed');
                            log.error(err);
                            if (cb) {
                                cb(err);
                                clearTimeout(waitRestore);
                            }
                        } else {
                            if (cb) {
                                const yahkaPth = join(options.path, `yahka.${num[0]}.hapdata`).replace(/\\/g, '/');

                                try {
                                    if (existsSync(yahkaPth)) {
                                        emptyDirSync(yahkaPth);
                                        if (!readdirSync(yahkaPth).length) {
                                            log.debug('Old Yahka Database is successfully deleted');
                                        }
                                    }
                                } catch {
                                    log.debug('old Yahka database cannot deleted');
                                }

                                try {
                                    copySync(tmpDir, yahkaPth);
                                    if (existsSync(yahkaPth)) {
                                        log.debug('Yahka Database is successfully restored');
                                    }
                                    log.debug('Try deleting the Yahka tmp directory');
                                    removeSync(tmpDir);
                                    if (!existsSync(tmpDir)) {
                                        log.debug('Yahka tmp directory was successfully deleted');
                                    }
                                    // Start yahka
                                    if (startAfterRestore) {
                                        void adapter.getForeignObject(
                                            `system.adapter.yahka.${num[0]}`,
                                            (err, obj) => {
                                                if (obj && !obj.common?.enabled) {
                                                    void adapter.setForeignState(
                                                        `system.adapter.yahka.${num[0]}.alive`,
                                                        true,
                                                    );
                                                    log.debug(`yahka.${num[0]} started`);
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
                                log.debug('Yahka Restore completed successfully');
                                cb?.(null, 'yahka database restore done');
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
