"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const fs_extra_1 = require("fs-extra");
const tools_1 = require("../tools");
const targz_1 = require("../targz");
/**
 * Mode for the temporary directory.
 *
 * As in 42-javascripts this is a string, and fs-extra's `getMode` spreads a non-number into its
 * defaults, so the value is discarded and the directory ends up with the default 0o777. Passing
 * `{ mode: 0o2775 }` would actually apply it. Left as found.
 */
const desiredMode = '0o2775';
async function command(options, log, callback) {
    log.debug('Start Redis Backup ...');
    let cb = callback;
    let nameSuffix;
    if (options.hostType === 'Slave') {
        nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
    }
    else {
        nameSuffix = options.nameSuffix ? options.nameSuffix : '';
    }
    const fileName = (0, node_path_1.join)(options.backupDir, `${options.redisType === 'remote' ? 'redis-remote' : 'redis'}_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`);
    const tmpDir = (0, node_path_1.join)(options.backupDir, 'redistmp').replace(/\\/g, '/');
    // The cast only silences the type; the value handed over is unchanged (see desiredMode).
    const modeArg = desiredMode;
    if (!(0, node_fs_1.existsSync)(tmpDir)) {
        try {
            (0, fs_extra_1.ensureDirSync)(tmpDir, modeArg);
            log.debug('Created redistmp directory');
        }
        catch {
            log.warn(`redis tmp directory "${tmpDir}" cannot created`);
        }
    }
    else {
        log.debug(`Try deleting the old redis tmp directory: "${tmpDir}"`);
        try {
            (0, fs_extra_1.removeSync)(tmpDir);
        }
        catch {
            log.warn(`old redis tmp directory "${tmpDir}" cannot deleted`);
        }
        if (!(0, node_fs_1.existsSync)(tmpDir)) {
            log.debug(`old redis tmp directory "${tmpDir}" successfully deleted`);
            try {
                (0, fs_extra_1.ensureDirSync)(tmpDir, modeArg);
                log.debug('Created new redistmp directory');
            }
            catch {
                log.warn(`redis tmp directory "${tmpDir}" cannot created`);
            }
        }
    }
    options.context.fileNames.push(fileName);
    const timer = setInterval(() => {
        if ((0, node_fs_1.existsSync)(fileName)) {
            const stats = (0, node_fs_1.statSync)(fileName);
            const fileSize = Math.floor(stats.size / (1024 * 1024));
            log.debug(`Packed ${fileSize}MB so far...`);
        }
    }, 10000);
    /** Removes the temporary directory after a successful pack */
    const dropTmp = () => {
        try {
            log.debug(`Try deleting the redis tmp directory: "${tmpDir}"`);
            (0, fs_extra_1.removeSync)(tmpDir);
            if (!(0, node_fs_1.existsSync)(tmpDir)) {
                log.debug(`redis tmp directory "${tmpDir}" successfully deleted`);
            }
        }
        catch (err) {
            log.warn(`redis tmp directory "${tmpDir}" cannot deleted ... ${err}`);
            cb?.(err);
        }
    };
    if (options.redisType === 'local') {
        let name;
        let pth;
        let data = [];
        if ((0, node_fs_1.existsSync)(options.path)) {
            const stat = (0, node_fs_1.statSync)(options.path);
            if (!stat.isDirectory()) {
                const parts = options.path.replace(/\\/g, '/').split('/');
                name = parts.pop();
                pth = parts.join('/');
                data.push(name);
            }
            else {
                pth = options.path;
                try {
                    data = (0, node_fs_1.readdirSync)(pth);
                }
                catch (err) {
                    cb?.(err);
                }
            }
        }
        // save aof
        if (options.aof) {
            // Note: bgSave never settles when `redis-cli save` fails, so this await can hang.
            await bgSave(options, tmpDir, log, cb);
        }
        // Note: with several .rdb files this packs - and reports - once per file. And when no .rdb
        // file is found nothing runs at all and the callback never fires. Kept as found.
        data.forEach(file => {
            const currentFiletype = file.split('.').pop();
            if (currentFiletype === 'rdb' && !file.startsWith('temp')) {
                log.debug(`detected redis file: ${file} | file type: ${currentFiletype}`);
                try {
                    (0, tools_1.copyFile)((0, node_path_1.join)(pth, file), (0, node_path_1.join)(tmpDir, file), err => {
                        if (err) {
                            clearInterval(timer);
                            options.context.errors.redis = err.toString();
                            log.error(err);
                            cb?.(err);
                        }
                        else {
                            (0, targz_1.compress)({
                                src: tmpDir,
                                dest: fileName,
                                tar: {
                                    ignore: nm => !!name && name !== nm.replace(/\\/g, '/').split('/').pop(),
                                },
                            }, 
                            // lib/targz only ever passes an error; the stdout/stderr parameters
                            // the original declared here were always undefined.
                            packErr => {
                                clearInterval(timer);
                                if (packErr) {
                                    options.context.errors.redis = packErr.toString();
                                    cb?.(packErr);
                                }
                                else {
                                    log.debug(`Backup created: ${fileName}`);
                                    options.context.done.push('redis');
                                    options.context.types.push('redis');
                                    dropTmp();
                                    if (cb) {
                                        cb(null);
                                        cb = undefined;
                                    }
                                }
                            });
                        }
                    });
                }
                catch (err) {
                    clearInterval(timer);
                    cb?.(err);
                    cb = undefined;
                }
            }
        });
    }
    else if (options.redisType === 'remote') {
        try {
            (0, node_child_process_1.exec)(`redis-cli -u 'redis://${options.user && options.pass ? `${options.user}:${options.pass}@` : ''}${options.host}:${options.port}' --rdb ${(0, node_path_1.join)(tmpDir, 'dump.rdb').replace(/\\/g, '/')}`, error => {
                if (error) {
                    clearInterval(timer);
                    // `ExecException` is declared as Omit<ErrnoException, 'code'>, which drops
                    // the nominal Error identity; binding it back keeps toString() identical.
                    const failure = error;
                    options.context.errors.redis = failure.toString();
                    log.error(failure);
                    cb?.(error);
                }
                else {
                    (0, targz_1.compress)({
                        src: tmpDir,
                        dest: fileName,
                    }, packErr => {
                        clearInterval(timer);
                        if (packErr) {
                            options.context.errors.redis = packErr.toString();
                            cb?.(packErr);
                        }
                        else {
                            log.debug(`Backup created: ${fileName}`);
                            options.context.done.push('redis');
                            options.context.types.push('redis');
                            dropTmp();
                            if (cb) {
                                cb(null);
                                cb = undefined;
                            }
                        }
                    });
                }
            });
        }
        catch (err) {
            clearInterval(timer);
            cb?.(err);
            cb = undefined;
        }
    }
    // Note: any other redisType leaves the step without a callback.
}
/**
 * Asks redis to write its dump before the files are copied.
 *
 * On failure the promise is neither resolved nor rejected, so the caller's `await` never returns -
 * the error only reaches the callback. Kept as found.
 *
 * @param options script options, for the error store
 * @param tmpDir temporary directory that is removed on failure
 * @param log adapter logger
 * @param callback reports the failure
 */
function bgSave(options, tmpDir, log, callback) {
    return new Promise(resolve => {
        log.debug('redis-cli save started, please wait ...');
        let localCallback = callback;
        (0, node_child_process_1.exec)(`redis-cli save`, (error, stdout, stderr) => {
            if (error) {
                const failure = error;
                options.context.errors.redis = failure.toString();
                try {
                    log.debug(`Try deleting the redis tmp directory: "${tmpDir}"`);
                    (0, fs_extra_1.removeSync)(tmpDir);
                    if (!(0, node_fs_1.existsSync)(tmpDir)) {
                        log.debug(`redis tmp directory "${tmpDir}" successfully deleted`);
                    }
                }
                catch (err) {
                    log.warn(`redis tmp directory "${tmpDir}" cannot deleted ... ${err}`);
                    localCallback?.(err);
                    localCallback = undefined;
                }
                localCallback?.(error);
                localCallback = undefined;
            }
            else {
                log.debug('redis-cli save finish');
                resolve(stdout ? stdout : stderr);
            }
        });
    });
}
exports.ignoreErrors = true;
//# sourceMappingURL=32-redis.js.map