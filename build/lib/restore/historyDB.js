"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStop = void 0;
exports.restore = restore;
const node_fs_1 = require("node:fs");
const targz_1 = require("../targz");
function restore(options, fileName, log, adapter, callback) {
    let cb = callback;
    log.debug('Start History Restore ...');
    // stop history-Adapter before Restore
    let startAfterRestore = false;
    const enabledInstances = [];
    try {
        // Not awaited anywhere, so the instances may still be stopping when the unpacking starts.
        // Kept as found.
        adapter.getObjectView('system', 'instance', { startkey: 'system.adapter.history.', endkey: 'system.adapter.history.\u9999' }, (err, instances) => {
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
                    // Stop history Instances
                    void adapter.getForeignObject(`system.adapter.${_id}`, (err, obj) => {
                        if (obj?.common?.enabled) {
                            void adapter.setForeignState(`system.adapter.${_id}.alive`, false);
                            log.debug(`${_id} is stopped`);
                            enabledInstances.push(_id);
                            startAfterRestore = true;
                        }
                    });
                }
            }
            else {
                log.debug('Could not retrieve history instances!');
            }
        });
    }
    catch {
        log.debug('Could not retrieve history instances!');
    }
    // Created through the adapter but cleared with the global clearInterval below. Kept as found.
    const timer = adapter.setInterval(() => {
        if ((0, node_fs_1.existsSync)(options.path)) {
            log.debug('Extracting History Backup file...');
        }
        else {
            log.debug('Something is wrong. No file found.');
        }
    }, 10000);
    try {
        (0, targz_1.decompress)({
            src: fileName,
            dest: options.path,
        }, 
        // lib/targz only ever passes an error, so the `stderr` the original forwarded as the
        // exit code was always undefined.
        err => {
            clearInterval(timer);
            if (err) {
                log.error(err);
                if (cb) {
                    log.error('History Restore not completed');
                    cb(err);
                    cb = undefined;
                }
            }
            else {
                if (cb) {
                    // Start history Instances
                    if (startAfterRestore) {
                        try {
                            enabledInstances.forEach(enabledInstance => {
                                void adapter.getForeignObject(`system.adapter.${enabledInstance}`, (err, obj) => {
                                    if (obj && !obj.common?.enabled) {
                                        void adapter.setForeignState(`system.adapter.${enabledInstance}.alive`, true);
                                        log.debug(`${enabledInstance} started`);
                                    }
                                });
                            });
                        }
                        catch {
                            log.debug(`History instance cannot be started`);
                        }
                    }
                    log.debug('History Restore completed successfully');
                    cb(null, 'historyDB restore done');
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
//# sourceMappingURL=historyDB.js.map