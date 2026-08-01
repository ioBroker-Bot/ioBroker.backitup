"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStop = void 0;
exports.restore = restore;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const fs_extra_1 = require("fs-extra");
const targz_1 = require("../targz");
/** Module level, so a second restore overwrites the handle of the first. Kept as found. */
let waitRestore;
function restore(options, fileName, log, adapter, callback) {
    let cb = callback;
    log.debug('Start Zigbee Restore ...');
    const instance = fileName.split('.');
    const num = instance[1].split('_');
    const tmpDir = (0, node_path_1.join)(options.backupDir, `zigbee_${num[0]}`).replace(/\\/g, '/');
    const zigbeePth = (0, node_path_1.join)(options.path, `zigbee_${num[0]}`).replace(/\\/g, '/');
    log.debug(`Filename for Restore: ${fileName}`);
    // A string, so fs-extra reads no mode from it and falls back to the default. Kept as found.
    const desiredMode = '0o2775';
    try {
        (0, fs_extra_1.ensureDirSync)(tmpDir, desiredMode);
        log.debug(`zigbee tmp directory created: ${tmpDir}`);
    }
    catch {
        log.debug('zigbee tmp directory cannot created');
    }
    if ((0, node_fs_1.existsSync)(zigbeePth)) {
        try {
            (0, fs_extra_1.emptyDirSync)(zigbeePth);
            if (!(0, node_fs_1.readdirSync)(zigbeePth).length) {
                log.debug('old Zigbee database was successfully deleted');
            }
        }
        catch {
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
        waitRestore = setTimeout(() => (0, targz_1.decompress)({
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
            }
            else {
                if (cb) {
                    try {
                        (0, fs_extra_1.copySync)(tmpDir, zigbeePth);
                        if ((0, node_fs_1.existsSync)(zigbeePth)) {
                            log.debug('Zigbee Database is successfully restored');
                        }
                        log.debug('Try deleting the Zigbee tmp directory');
                        (0, fs_extra_1.removeSync)(tmpDir);
                        if (!(0, node_fs_1.existsSync)(tmpDir)) {
                            log.debug('Zigbee tmp directory was successfully deleted');
                        }
                        // Start zigbee
                        if (startAfterRestore) {
                            void adapter.getForeignObject(`system.adapter.zigbee.${num[0]}`, (err, obj) => {
                                if (obj && !obj.common?.enabled) {
                                    void adapter.setForeignState(`system.adapter.zigbee.${num[0]}.alive`, true);
                                    log.debug(`zigbee.${num[0]} started`);
                                }
                            });
                        }
                    }
                    catch (err) {
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
        }), 3000);
    }
    catch (e) {
        if (cb) {
            cb(e);
            cb = undefined;
            clearTimeout(waitRestore);
        }
    }
}
exports.isStop = false;
//# sourceMappingURL=zigbee.js.map