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
    log.debug('Start Yahka Restore ...');
    const instance = fileName.split('.');
    const num = instance[1].split('_');
    const tmpDir = (0, node_path_1.join)(options.backupDir, `yahka_${num[0]}.hapdata`).replace(/\\/g, '/');
    log.debug(`Filename for Restore: ${fileName}`);
    // A string, so fs-extra reads no mode from it and falls back to the default. Kept as found.
    const desiredMode = '0o2775';
    try {
        (0, fs_extra_1.ensureDirSync)(tmpDir, desiredMode);
        log.debug(`yahka tmp directory created: ${tmpDir}`);
    }
    catch {
        log.debug('yahka tmp directory cannot created');
    }
    if ((0, node_fs_1.existsSync)(`${options.path}/yahka.${num[0]}.hapdata`)) {
        try {
            (0, fs_extra_1.removeSync)(`${options.path}/yahka.${num[0]}.hapdata`);
            if (!(0, node_fs_1.existsSync)(`${options.path}/yahka.${num[0]}.hapdata`)) {
                log.debug('old Yahka database directory was successfully deleted');
            }
        }
        catch {
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
        waitRestore = setTimeout(() => (0, targz_1.decompress)({
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
            }
            else {
                if (cb) {
                    const yahkaPth = (0, node_path_1.join)(options.path, `yahka.${num[0]}.hapdata`).replace(/\\/g, '/');
                    try {
                        if ((0, node_fs_1.existsSync)(yahkaPth)) {
                            (0, fs_extra_1.emptyDirSync)(yahkaPth);
                            if (!(0, node_fs_1.readdirSync)(yahkaPth).length) {
                                log.debug('Old Yahka Database is successfully deleted');
                            }
                        }
                    }
                    catch {
                        log.debug('old Yahka database cannot deleted');
                    }
                    try {
                        (0, fs_extra_1.copySync)(tmpDir, yahkaPth);
                        if ((0, node_fs_1.existsSync)(yahkaPth)) {
                            log.debug('Yahka Database is successfully restored');
                        }
                        log.debug('Try deleting the Yahka tmp directory');
                        (0, fs_extra_1.removeSync)(tmpDir);
                        if (!(0, node_fs_1.existsSync)(tmpDir)) {
                            log.debug('Yahka tmp directory was successfully deleted');
                        }
                        // Start yahka
                        if (startAfterRestore) {
                            void adapter.getForeignObject(`system.adapter.yahka.${num[0]}`, (err, obj) => {
                                if (obj && !obj.common?.enabled) {
                                    void adapter.setForeignState(`system.adapter.yahka.${num[0]}.alive`, true);
                                    log.debug(`yahka.${num[0]} started`);
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
                    log.debug('Yahka Restore completed successfully');
                    cb?.(null, 'yahka database restore done');
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
//# sourceMappingURL=yahka.js.map