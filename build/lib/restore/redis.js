"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStop = void 0;
exports.restore = restore;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const fs_extra_1 = require("fs-extra");
const tools_1 = require("../tools");
const targz_1 = require("../targz");
/** Module level, so a second restore overwrites the handle of the first. Kept as found. */
let waitRestore;
function restore(options, fileName, log, callback) {
    let cb = callback;
    log.debug('Start Redis Restore ...');
    // A string, so fs-extra reads no mode from it and falls back to the default. Kept as found.
    const desiredMode = '0o2775';
    const tmpDir = (0, node_path_1.join)(options.backupDir, 'redistmp').replace(/\\/g, '/');
    if (!(0, node_fs_1.existsSync)(tmpDir)) {
        (0, fs_extra_1.ensureDirSync)(tmpDir, desiredMode);
        log.debug('Created redistmp directory');
    }
    else {
        log.debug(`Try deleting the old redis tmp directory: "${tmpDir}"`);
        (0, fs_extra_1.removeSync)(tmpDir);
        if (!(0, node_fs_1.existsSync)(tmpDir)) {
            log.debug(`old redis tmp directory "${tmpDir}" successfully deleted`);
            (0, fs_extra_1.ensureDirSync)(tmpDir, desiredMode);
            log.debug('Created redistmp directory');
        }
    }
    const timer = setInterval(() => {
        if ((0, node_fs_1.existsSync)(options.path)) {
            log.debug('Extracting Redis Backup file...');
        }
        else {
            log.debug('Something is wrong. No file found.');
        }
    }, 10000);
    let name;
    // NOTE: `pth` stays undefined when `options.path` exists as a directory is false *and* the
    // file name starts with a dot - `indexOf('.')` is checked for truthiness, so only position 0
    // counts as "no dot". `join(undefined, file)` then throws below. Kept as found.
    let pth;
    if (!(0, node_fs_1.existsSync)(options.path)) {
        const parts = options.path.replace(/\\/g, '/').split('/');
        name = parts.pop();
        if (name.indexOf('.')) {
            pth = parts.join('/');
        }
    }
    else {
        pth = options.path;
    }
    try {
        log.debug('decompress started ...');
        waitRestore = setTimeout(() => (0, targz_1.decompress)({
            src: fileName,
            dest: tmpDir,
        }, 
        // lib/targz only ever passes an error, so the `stderr` the original forwarded
        // as the exit code was always undefined.
        err => {
            if (err) {
                clearInterval(timer);
                log.error('Redis Restore not completed');
                log.error(err);
                if (cb) {
                    cb(err);
                    cb = undefined;
                }
            }
            else {
                clearInterval(timer);
                if (cb) {
                    let files = [];
                    if ((0, node_fs_1.existsSync)(tmpDir)) {
                        files = (0, node_fs_1.readdirSync)(tmpDir);
                        let num = 0;
                        files.forEach(file => {
                            try {
                                (0, tools_1.copyFile)((0, node_path_1.join)(tmpDir, file), (0, node_path_1.join)(pth, file), err => {
                                    if (err) {
                                        log.error(err);
                                        cb?.(null, 'redis restore broken');
                                        cb = undefined;
                                    }
                                    else {
                                        num++;
                                        if ((0, node_fs_1.existsSync)((0, node_path_1.join)(`${pth}/${file}`))) {
                                            log.debug(`redis file ${file} successfully restored`);
                                        }
                                        log.debug('redis-cli restart, please wait ...');
                                        if (files.length === num) {
                                            if (options.aof === true) {
                                                log.debug('redis-cli bgrewriteaof started, please wait ...');
                                                try {
                                                    (0, node_child_process_1.exec)(`redis-cli bgrewriteaof`, error => {
                                                        if (error) {
                                                            log.debug(`redis-cli bgrewriteaof error: "${error}"`);
                                                        }
                                                    });
                                                }
                                                catch (e) {
                                                    log.debug(`redis-cli bgrewriteaof error: "${e}"`);
                                                }
                                            }
                                            try {
                                                log.debug(`Try deleting the redis tmp directory: "${tmpDir}"`);
                                                (0, fs_extra_1.removeSync)(tmpDir);
                                                if (!(0, node_fs_1.existsSync)(tmpDir)) {
                                                    log.debug(`redis tmp directory "${tmpDir}" successfully deleted`);
                                                }
                                            }
                                            catch (err) {
                                                // Reports and clears the callback, but
                                                // does not return - the success report
                                                // below is therefore skipped.
                                                log.debug(`redis tmp directory "${tmpDir}" cannot deleted ... ${err}`);
                                                cb?.(null, 'redis restore is incomplete');
                                                cb = undefined;
                                            }
                                            clearTimeout(waitRestore);
                                            log.debug('Redis Restore completed successfully');
                                            cb?.(null, 'redis restore done');
                                            cb = undefined;
                                        }
                                    }
                                });
                            }
                            catch (err) {
                                log.error(`Redis Restore not completed: ${err}`);
                                cb?.(null, 'redis restore is incomplete');
                                cb = undefined;
                            }
                        });
                    }
                }
            }
        }), 2000);
    }
    catch (e) {
        if (cb) {
            clearInterval(timer);
            cb(e);
            cb = undefined;
        }
    }
}
exports.isStop = true;
//# sourceMappingURL=redis.js.map