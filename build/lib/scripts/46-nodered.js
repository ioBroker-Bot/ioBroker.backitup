"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const fs_extra_1 = require("fs-extra");
const tools_1 = require("../tools");
const targz_1 = require("../targz");
async function command(options, log, callback) {
    const noderedInst = [];
    try {
        // Note: the loop runs to 100 but only index 10 reports back, and only when no matching
        // directory exists there. With a `node-red.10` present nothing calls the callback at all.
        // Kept as found.
        for (let i = 0; i <= 100; i++) {
            const nrDir = i === 0 ? 'node-red' : `node-red.${i}`;
            const pth = (0, node_path_1.join)(options.path, nrDir).replace(/\\/g, '/');
            if ((0, node_fs_1.existsSync)(pth)) {
                noderedInst.push(`node-red.${i}`);
                const nameSuffix = options.hostType === 'Slave' && options.slaveSuffix
                    ? options.slaveSuffix
                    : options.hostType !== 'Slave' && options.nameSuffix
                        ? options.nameSuffix
                        : '';
                const fileName = (0, node_path_1.join)(options.backupDir, `nodered.${i}_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`);
                const tmpDir = (0, node_path_1.join)(options.backupDir, `noderedtmp${i}`).replace(/\\/g, '/');
                const desiredMode = {
                    mode: 0o2775,
                };
                if (!(0, node_fs_1.existsSync)(tmpDir)) {
                    log.debug('Created nodered tmp directory');
                    try {
                        await (0, fs_extra_1.ensureDir)(tmpDir, desiredMode);
                    }
                    catch {
                        log.error(`Node-Red tmp directory "${tmpDir}" cannot created`);
                    }
                }
                else {
                    try {
                        await delTmp(options, tmpDir, log);
                    }
                    catch {
                        log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
                    }
                    if (!(0, node_fs_1.existsSync)(tmpDir)) {
                        log.debug('Created new nodered tmp directory');
                        try {
                            await (0, fs_extra_1.ensureDir)(tmpDir, desiredMode);
                        }
                        catch {
                            log.error(`Node-Red tmp directory "${tmpDir}" cannot created`);
                        }
                    }
                }
                await tmpCopy(pth, tmpDir, log);
                await compressBackupFile(fileName, tmpDir, log, options, callback);
                try {
                    await delTmp(options, tmpDir, log);
                }
                catch {
                    log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
                }
                options.context.fileNames.push(fileName);
                options.context.types.push(`nodered.${i}`);
                options.context.done.push(`nodered.${i}`);
                if (i === 10) {
                    if (noderedInst.length) {
                        log.debug(`found node-red database: ${noderedInst.join(',')}`);
                    }
                    else {
                        log.warn('no Node-Red database found!!');
                    }
                }
            }
            else if (!(0, node_fs_1.existsSync)(pth) && i === 10) {
                if (noderedInst.length) {
                    log.debug(`found node-red database: ${noderedInst.join(',')}`);
                }
                else {
                    log.warn('no node-red database found!!');
                }
                callback?.(null, 'done');
            }
        }
    }
    catch (err) {
        options.context.errors.nodered = JSON.stringify(err);
        log.error(`Error on node-red Backup: ${err}`);
        callback?.(null, err);
    }
}
/**
 * Removes a temporary directory, rejecting when it cannot be deleted.
 *
 * @param options script options, for the error store
 * @param tmpDir directory to remove
 * @param log adapter logger
 */
async function delTmp(options, tmpDir, log) {
    log.debug(`Try deleting the old node-red tmp directory: "${tmpDir}"`);
    return (0, fs_extra_1.remove)(tmpDir)
        .then(() => {
        if (!(0, node_fs_1.existsSync)(tmpDir)) {
            log.debug(`node-red tmp directory "${tmpDir}" successfully deleted`);
        }
    })
        .catch(err => {
        options.context.errors.nodered = JSON.stringify(err);
        log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
        throw err;
    });
}
/**
 * Copies the Node-RED data aside, leaving node_modules out.
 *
 * @param pth source directory
 * @param tmpDir destination directory
 * @param log adapter logger
 */
async function tmpCopy(pth, tmpDir, log) {
    return (0, fs_extra_1.copy)(pth, tmpDir, { filter: entry => !entry.includes('node_modules') }).then(() => {
        log.debug('Node-Red tmp copy finish');
    });
}
/**
 * Packs the prepared copy.
 *
 * The callback parameter is deliberately local: the original cleared it here, which never reached
 * the caller's variable, so `command` can still report afterwards. On failure the promise rejects
 * without a reason - and when no callback was handed in it neither resolves nor rejects, stalling
 * the loop. Both preserved.
 *
 * @param fileName archive to write
 * @param tmpDir prepared copy to pack
 * @param log adapter logger
 * @param options script options, for the error store
 * @param callback reports a packing failure
 */
async function compressBackupFile(fileName, tmpDir, log, options, callback) {
    return new Promise((resolve, reject) => {
        let localCallback = callback;
        (0, targz_1.compress)({
            src: tmpDir,
            dest: fileName,
        }, 
        // lib/targz only ever passes an error; the second parameter the original declared here
        // was always undefined.
        err => {
            if (err) {
                options.context.errors.nodered = err.toString();
                if (localCallback) {
                    localCallback(err);
                    localCallback = undefined;
                    reject(undefined);
                }
            }
            else {
                log.debug(`Backup created: ${fileName}`);
                resolve();
            }
        });
    });
}
exports.ignoreErrors = true;
//# sourceMappingURL=46-nodered.js.map