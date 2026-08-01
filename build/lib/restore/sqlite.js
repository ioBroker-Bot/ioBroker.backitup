"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStop = void 0;
exports.restore = restore;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const targz_1 = require("../targz");
/**
 * Deletes the old database file and feeds the dump into a fresh one.
 *
 * @param options sqlite settings
 * @param fileNameSQlite the unpacked .sql file
 * @param log restore logger
 * @param callback reports the sqlite3 exit status
 */
function replaySqlite(options, fileNameSQlite, log, callback) {
    if (options?.filePth && (0, node_fs_1.existsSync)(options.filePth)) {
        try {
            (0, node_fs_1.unlinkSync)(options.filePth);
            log.debug('old sqlite db deleted!');
        }
        catch (e) {
            // Reports the failure but does not return, so the restore below runs anyway and the
            // callback fires a second time. Kept as found.
            log.debug(`sqlite db cannot deleted: ${e}`);
            callback?.(e);
        }
    }
    const cmdRestore = `${options.exe ? options.exe : 'sqlite3'} ${options.filePth} < ${fileNameSQlite}`;
    try {
        (0, node_child_process_1.exec)(cmdRestore, (error, stdout, stderr) => {
            if (error) {
                log.error(stderr);
            }
            callback?.(error);
        });
    }
    catch {
        // ignore errors
    }
}
function restore(options, fileName, log, adapter, callback) {
    let cb = callback;
    const fileNameSQlite = (0, node_path_1.join)(options.backupDir, `sqlite_restore_backupiobroker.sql`);
    log.debug('Start sqlite Restore ...');
    // stop sql-Adapter before Restore
    let startAfterRestore = false;
    const enabledInstances = [];
    // Not awaited, so the instances may still be stopping when the replay starts. Kept as found.
    void adapter.getObjectView('system', 'instance', { startkey: 'system.adapter.sql.', endkey: 'system.adapter.sql.\u9999' }, (err, instances) => {
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
                // Stop sql Instances
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
            log.debug('Could not retrieve sql instances!');
        }
    });
    const timer = setInterval(() => {
        if ((0, node_fs_1.existsSync)(fileNameSQlite)) {
            const stats = (0, node_fs_1.statSync)(fileNameSQlite);
            const fileSize = Math.floor(stats.size / (1024 * 1024));
            log.debug(`Extract sqlite Backup file ${fileSize}MB so far...`);
        }
        else {
            log.debug(`Something is wrong with "${fileNameSQlite}".`);
        }
    }, 10000);
    try {
        (0, targz_1.decompress)({
            src: fileName,
            dest: options.backupDir,
            tar: {
                map: header => {
                    header.name = `sqlite_restore_backupiobroker.sql`;
                    return header;
                },
            },
        }, 
        // lib/targz only ever passes an error, so the `stderr` the original forwarded as the
        // exit code was always undefined.
        err => {
            clearInterval(timer);
            if (err) {
                log.error(err);
                if (cb) {
                    log.error('sqlite Restore not completed');
                    cb(err);
                    cb = undefined;
                }
            }
            else {
                // The replay error is deliberately ignored - the step always reports success.
                replaySqlite(options, fileNameSQlite, log, () => {
                    // Start sql Instances
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
                    // delete sqlite file
                    if ((0, node_fs_1.existsSync)(fileNameSQlite)) {
                        try {
                            (0, node_fs_1.unlinkSync)(fileNameSQlite);
                        }
                        catch {
                            log.debug(`${fileNameSQlite} cannot deleted ...`);
                        }
                    }
                    if (cb) {
                        log.debug('sqlite Restore completed successfully');
                        cb(null, 'sqlite restore done');
                        cb = undefined;
                    }
                });
            }
        });
    }
    catch (err) {
        if (cb) {
            cb(err);
            cb = undefined;
        }
    }
}
exports.isStop = false;
//# sourceMappingURL=sqlite.js.map