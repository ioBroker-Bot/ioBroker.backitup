"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStop = void 0;
exports.restore = restore;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const fs_extra_1 = require("fs-extra");
const targz_1 = require("../targz");
async function restore(options, fileName, log, adapter, callback) {
    let cb = callback;
    log.debug('Start Jarvis Restore ...');
    const instance = fileName.split('.');
    const num = instance[1].split('_');
    const tmpDir = (0, node_path_1.join)(options.backupDir, `jarvis_${num[0]}`).replace(/\\/g, '/');
    const stateDir = (0, node_path_1.join)(tmpDir, 'states').replace(/\\/g, '/');
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
        await (0, fs_extra_1.ensureDir)(tmpDir);
        log.debug(`jarvis tmp directory created: ${tmpDir}`);
    }
    catch {
        log.debug('jarvis tmp directory cannot created');
    }
    const pthJarvis = (0, node_path_1.join)(options.path, 'jarvis');
    const pth = (0, node_path_1.join)(pthJarvis, num[0]);
    if ((0, node_fs_1.existsSync)(pth)) {
        try {
            await (0, fs_extra_1.remove)(pth);
            if (!(0, node_fs_1.existsSync)(pth)) {
                log.debug('old jarvis database directory was successfully deleted');
            }
        }
        catch {
            log.debug('old jarvis database directory cannot deleted');
        }
    }
    try {
        (0, targz_1.decompress)({
            src: fileName,
            dest: tmpDir,
        }, 
        // lib/targz only ever passes an error, so the `stderr` the original forwarded as the
        // exit code was always undefined.
        async (err) => {
            if (err) {
                log.error('jarvis restore not completed');
                log.error(err);
                if (cb) {
                    cb(err);
                    cb = undefined;
                }
            }
            else {
                if (cb) {
                    try {
                        // Restore States
                        const object = await (0, promises_1.readFile)((0, node_path_1.join)(stateDir, 'states.json'));
                        if (object) {
                            const jarvisObjects = JSON.parse(object.toString());
                            // for-in, not for-of: it also visits whatever a non-array
                            // states.json deserialises to. Kept as found.
                            // eslint-disable-next-line @typescript-eslint/no-for-in-array
                            for (const i in jarvisObjects) {
                                let _object;
                                try {
                                    _object = await adapter.getForeignObjectAsync(jarvisObjects[i].id);
                                }
                                catch (err) {
                                    log.debug(err);
                                }
                                if (_object) {
                                    try {
                                        if (jarvisObjects[i].value !== null) {
                                            await adapter.setForeignStateAsync(jarvisObjects[i].id, jarvisObjects[i].value, true);
                                        }
                                    }
                                    catch (err) {
                                        log.debug(`Error on set Object: ${err}`);
                                    }
                                }
                            }
                        }
                        log.debug('Try deleting the states tmp directory');
                        await (0, fs_extra_1.remove)(stateDir);
                        if (!(0, node_fs_1.existsSync)(stateDir)) {
                            log.debug('states tmp directory was successfully deleted');
                        }
                        // Restore Backup-Files
                        await (0, fs_extra_1.copy)(tmpDir, pth);
                        if ((0, node_fs_1.existsSync)(pth)) {
                            log.debug('jarvis database is successfully restored');
                        }
                        // Start jarvis
                        if (startAfterRestore) {
                            const obj = await adapter.getForeignObjectAsync(`system.adapter.jarvis.${num[0]}`);
                            if (obj && !obj.common?.enabled) {
                                await adapter.setForeignStateAsync(`system.adapter.jarvis.${num[0]}.alive`, true);
                                log.debug(`jarvis.${num[0]} started`);
                            }
                        }
                        log.debug('Try deleting the jarvis tmp directory');
                        await (0, fs_extra_1.remove)(tmpDir);
                        if (!(0, node_fs_1.existsSync)(tmpDir)) {
                            log.debug('jarvis tmp directory was successfully deleted');
                        }
                    }
                    catch (err) {
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
        });
    }
    catch (e) {
        if (cb) {
            cb(e);
            cb = undefined;
        }
    }
}
exports.isStop = false;
//# sourceMappingURL=jarvis.js.map