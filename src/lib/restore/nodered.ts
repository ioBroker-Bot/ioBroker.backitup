import { exec } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { copySync, emptyDirSync, ensureDirSync, removeSync } from 'fs-extra';

import { decompress } from '../targz';
import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

interface NoderedRestoreOptions extends BackItUpRestoreOptions {
    /** parent directory holding the node-red / node-red.<n> directories */
    path: string;
}

/** Module level, so a second restore overwrites the handle of the first. Kept as found. */
let waitRestore: NodeJS.Timeout | undefined;

export function restore(
    options: NoderedRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    adapter: ioBroker.Adapter,
    callback?: BackItUpRestoreCallback,
): void {
    let cb = callback;

    log.debug('Start Node-Red Restore ...');

    const onlyFileName = fileName.split('/').pop()!;
    const instance = onlyFileName.split('.');
    const num = instance[1].split('_');
    const nrDir = num[0] === '0' ? 'node-red' : `node-red.${num[0]}`;

    const tmpDir = join(options.backupDir, `node-red.${num[0]}`).replace(/\\/g, '/');
    const noderedPth = join(options.path, nrDir).replace(/\\/g, '/');

    log.debug(`Filename for Restore: ${fileName}`);

    // A string, so fs-extra reads no mode from it and falls back to the default. Kept as found.
    const desiredMode = '0o2775';

    try {
        ensureDirSync(tmpDir, desiredMode as unknown as number);
        log.debug(`node-red tmp directory created: ${tmpDir}`);
    } catch {
        log.debug('node-red tmp directory cannot created');
    }

    if (existsSync(noderedPth)) {
        try {
            emptyDirSync(noderedPth);
            if (!readdirSync(noderedPth).length) {
                log.debug('old Node-Red database was successfully deleted');
            }
        } catch {
            log.debug('old Node-Red database cannot deleted');
        }
    }
    // Stop node-red - not awaited, so the 3s delay below is what the unpacking relies on.
    let startAfterRestore = false;
    void adapter.getForeignObject(`system.adapter.node-red.${num[0]}`, (err, obj) => {
        if (obj?.common?.enabled) {
            void adapter.setForeignState(`system.adapter.node-red.${num[0]}.alive`, false);
            log.debug(`node-red.${num[0]} stopped`);
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
                            log.error('Node-Red Restore not completed');
                            log.error(err);
                            if (cb) {
                                cb(err);
                                clearTimeout(waitRestore);
                            }
                        } else {
                            if (cb) {
                                try {
                                    copySync(tmpDir, noderedPth);
                                    if (existsSync(noderedPth)) {
                                        log.debug('Node-Red Database is successfully restored');
                                    }
                                    log.debug('Try deleting the Node-Red tmp directory');
                                    removeSync(tmpDir);
                                    if (!existsSync(tmpDir)) {
                                        log.debug('Node-Red tmp directory was successfully deleted');
                                    }

                                    // NOTE: when the target does not exist the callback is never
                                    // invoked and the restore hangs. Kept as found.
                                    if (existsSync(noderedPth)) {
                                        log.debug(`Try "npm install" for ${noderedPth}`);

                                        exec(
                                            `npm --prefix ${noderedPth} install ${noderedPth}`,
                                            (error, stdout) => {
                                                if (error) {
                                                    log.debug(
                                                        `To complete the restore, please run an "npm install" manually in the path "${noderedPth}".`,
                                                    );
                                                    cb?.(error);
                                                    clearTimeout(waitRestore);
                                                } else {
                                                    if (stdout) {
                                                        log.debug(`npm install \n${stdout}`);
                                                    }
                                                    // Start node-red
                                                    if (startAfterRestore) {
                                                        void adapter.getForeignObject(
                                                            `system.adapter.node-red.${num[0]}`,
                                                            (err, obj) => {
                                                                if (obj && !obj.common?.enabled) {
                                                                    void adapter.setForeignState(
                                                                        `system.adapter.node-red.${num[0]}.alive`,
                                                                        true,
                                                                    );
                                                                    log.debug(`node-red.${num[0]} started`);
                                                                }
                                                            },
                                                        );
                                                        log.debug('Node-Red Restore completed successfully');
                                                        cb?.(null, 'node-red restore done');
                                                        cb = undefined;
                                                        clearTimeout(waitRestore);
                                                    } else {
                                                        log.debug('Node-Red Restore completed successfully');
                                                        cb?.(null, 'node-red restore done');
                                                        cb = undefined;
                                                        clearTimeout(waitRestore);
                                                    }
                                                }
                                            },
                                        );
                                    }
                                } catch (err) {
                                    cb?.(err);
                                    clearTimeout(waitRestore);
                                }
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
