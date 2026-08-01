"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStop = void 0;
exports.restore = restore;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const fs_extra_1 = require("fs-extra");
const targz_1 = require("../targz");
/** Module level, so a second restore overwrites the handles of the first. Kept as found. */
let waitRestore;
let timerDone;
async function restore(options, fileName, log, adapter, callback) {
    let cb = callback;
    log.debug('Start Javascript Restore ...');
    // stop Javascript-Adapter before Restore
    let startAfterRestore = false;
    const enabledInstances = [];
    // Not awaited, so the instances may still be stopping when the unpacking starts. Kept as found.
    void adapter.getObjectView('system', 'instance', { startkey: 'system.adapter.javascript.', endkey: 'system.adapter.javascript.\u9999' }, (err, instances) => {
        const resultInstances = [];
        if (!err && instances && instances.rows) {
            instances.rows.forEach(row => {
                resultInstances.push({
                    id: row.id.replace('system.adapter.', ''),
                    config: row.value.native.type,
                });
            });
            for (let i = 0; i < resultInstances.length; i++) {
                const _id = resultInstances[i].id;
                // Stop Javascript Instances
                void adapter.getForeignObject(`system.adapter.${_id}`, (err, obj) => {
                    if (obj?.common?.enabled) {
                        void adapter.setForeignState(`system.adapter.${_id}.alive`, false);
                        log.debug(`${_id} is stopped`);
                        enabledInstances.push(_id);
                        // Spelled out; the original interpolated the array, which is the same
                        // comma-joined string.
                        log.debug(`enabled Instances: ${enabledInstances.join(',')}`);
                        startAfterRestore = true;
                    }
                });
            }
        }
        else {
            log.debug('Could not retrieve javascript instances!');
        }
    });
    const tmpDir = (0, node_path_1.join)(options.backupDir, 'tmpScripts').replace(/\\/g, '/');
    // A string, so fs-extra reads no mode from it and falls back to the default. Kept as found.
    const desiredMode = '0o2775';
    if (!(0, node_fs_1.existsSync)(tmpDir)) {
        try {
            (0, fs_extra_1.ensureDirSync)(tmpDir, desiredMode);
            log.debug(`Created javascript_tmp directory: "${tmpDir}"`);
        }
        catch (err) {
            log.debug(`Javascript tmp directory "${tmpDir}" cannot created ... ${err}`);
        }
    }
    else {
        try {
            log.debug(`Try deleting the old javascript_tmp directory: "${tmpDir}"`);
            (0, fs_extra_1.removeSync)(tmpDir);
        }
        catch (err) {
            log.debug(`Javascript tmp directory "${tmpDir}" cannot deleted ... ${err}`);
        }
        if (!(0, node_fs_1.existsSync)(tmpDir)) {
            try {
                log.debug(`old javascript_tmp directory "${tmpDir}" successfully deleted`);
                (0, fs_extra_1.ensureDirSync)(tmpDir, desiredMode);
                log.debug('Created javascript_tmp directory');
            }
            catch (err) {
                log.debug(`Javascript tmp directory "${tmpDir}" cannot created ... ${err}`);
            }
        }
    }
    try {
        log.debug('decompress started ...');
        waitRestore = setTimeout(() => (0, targz_1.decompress)({
            src: fileName,
            dest: tmpDir,
        }, 
        // lib/targz only ever passes an error, so the `stderr` the original forwarded
        // as the exit code was always undefined.
        async (err) => {
            if (err) {
                log.error(err);
                if (cb) {
                    log.error('Javascript Restore not completed');
                    cb(err);
                    cb = undefined;
                    clearTimeout(timerDone);
                    clearTimeout(waitRestore);
                }
            }
            else {
                await restoreJavascriptObjects(tmpDir, adapter, log);
                try {
                    log.debug(`Try deleting the Javascript tmp directory: "${tmpDir}"`);
                    (0, fs_extra_1.removeSync)(tmpDir);
                    if (!(0, node_fs_1.existsSync)(tmpDir)) {
                        log.debug(`Javascript tmp directory "${tmpDir}" successfully deleted`);
                    }
                }
                catch (err) {
                    log.debug(`Javascript tmp directory "${tmpDir}" cannot deleted ... ${err}`);
                }
                if (cb) {
                    // Start javascript Instances
                    if (startAfterRestore) {
                        enabledInstances.forEach(enabledInstance => {
                            void adapter.getForeignObject(`system.adapter.${enabledInstance}`, (err, obj) => {
                                if (obj && !obj.common?.enabled) {
                                    void adapter.setForeignState(`system.adapter.${enabledInstance}.alive`, true);
                                    log.debug(`${enabledInstance} started`);
                                }
                            });
                        });
                    }
                    timerDone = setTimeout(() => {
                        log.debug('Javascript Restore completed successfully');
                        // Reported twice: once with the "done" marker and once bare,
                        // so lib/restore.js runs its handler two times. Kept as found.
                        cb(null, 'javascript restore done');
                        cb(null);
                        cb = undefined;
                        clearTimeout(timerDone);
                        clearTimeout(waitRestore);
                    }, 2000);
                }
            }
        }), 2000);
    }
    catch (e) {
        if (cb) {
            cb(e);
            cb = undefined;
            clearTimeout(timerDone);
            clearTimeout(waitRestore);
        }
    }
}
/**
 * Writes the script objects from the unpacked script.json back into the object database.
 *
 * Always resolves - every failure is only logged.
 *
 * @param tmpDir directory the backup was unpacked into
 * @param adapter adapter instance used for the object access
 * @param log restore logger
 */
async function restoreJavascriptObjects(tmpDir, adapter, log) {
    try {
        const object = await (0, promises_1.readFile)((0, node_path_1.join)(tmpDir, 'script.json'));
        if (object) {
            const jsObjects = JSON.parse(object.toString());
            // for-in, not for-of: it also visits whatever a non-array script.json deserialises to.
            // Kept as found.
            // eslint-disable-next-line @typescript-eslint/no-for-in-array
            for (const i in jsObjects) {
                let _object;
                try {
                    _object = await adapter.getForeignObjectAsync(jsObjects[i]._id);
                }
                catch (err) {
                    log.debug(err);
                }
                if (_object) {
                    try {
                        await adapter.setForeignObjectAsync(jsObjects[i]._id, jsObjects[i]);
                        const scriptCheck = await adapter.getForeignObjectAsync(jsObjects[i]._id);
                        if (scriptCheck) {
                            log.debug(`Restore Script: ${jsObjects[i]._id.split('.').pop()}`);
                        }
                    }
                    catch (err) {
                        log.debug(`Error on set Object: ${err}`);
                    }
                }
                else {
                    try {
                        await adapter.setForeignObjectNotExistsAsync(jsObjects[i]._id, jsObjects[i]);
                        const scriptCheck = await adapter.getForeignObjectAsync(jsObjects[i]._id);
                        if (scriptCheck) {
                            log.debug(`Added Script: ${jsObjects[i]._id.split('.').pop()}`);
                        }
                    }
                    catch (err) {
                        log.debug(`Error on create Object: ${err}`);
                    }
                }
            }
        }
    }
    catch (err) {
        log.debug(`Error on Javascript-Restore: ${err}`);
    }
}
exports.isStop = false;
//# sourceMappingURL=javascripts.js.map