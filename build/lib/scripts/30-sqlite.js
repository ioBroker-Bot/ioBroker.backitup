"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const tools_1 = require("../tools");
const targz_1 = require("../targz");
async function command(options, log, callback) {
    log.debug('Start SQLite3 Backup ...');
    // stop sql-Adapter before Backup
    let startAfterBackup = false;
    const enabledInstances = [];
    const resultInstances = [];
    let cb = callback;
    const instances = await options.adapter
        .getObjectViewAsync('system', 'instance', {
        startkey: 'system.adapter.sql.',
        // U+9999 is the sentinel upper bound the ioBroker object views use, not a real character
        endkey: 'system.adapter.sql.香',
    })
        .catch(err => log.error(err));
    if (instances && instances.rows) {
        instances.rows.forEach(row => resultInstances.push({
            id: row.id.replace('system.adapter.', ''),
            config: row.value.native.type,
        }));
        for (let i = 0; i < resultInstances.length; i++) {
            const _id = resultInstances[i].id;
            const obj = await options.adapter
                .getForeignObjectAsync(`system.adapter.${_id}`)
                .catch(err => log.error(err));
            if (obj?.common?.enabled) {
                await options.adapter
                    .setForeignStateAsync(`system.adapter.${_id}.alive`, false)
                    .then(() => log.debug(`${_id} is stopped`))
                    .catch(err => log.error(err));
                enabledInstances.push(_id);
                startAfterBackup = true;
            }
        }
    }
    else {
        log.warn('Could not retrieve sql instances!');
    }
    const nameSuffix = options.hostType === 'Slave' && options.slaveSuffix
        ? options.slaveSuffix
        : options.hostType !== 'Slave' && options.nameSuffix
            ? options.nameSuffix
            : '';
    const fileName = (0, node_path_1.join)(options.backupDir, `sqlite_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`);
    const fileNameSQlite = (0, node_path_1.join)(options.backupDir, `sqlite_${(0, tools_1.getDate)()}_backupiobroker.sql`);
    options.context.fileNames.push(fileName);
    const timer = setInterval(() => {
        if ((0, node_fs_1.existsSync)(fileName)) {
            const stats = (0, node_fs_1.statSync)(fileName);
            const fileSize = Math.floor(stats.size / (1024 * 1024));
            log.debug(`Packed ${fileSize}MB so far...`);
        }
    }, 10000);
    try {
        (0, node_child_process_1.exec)(`${options.exe ? options.exe : 'sqlite3'} ${options.filePth} .dump > ${fileNameSQlite}`, error => {
            if (error) {
                clearInterval(timer);
                // `ExecException` is declared as Omit<ErrnoException, 'code'>, which drops the
                // nominal Error identity; binding it back keeps toString() and the log identical.
                const failure = error;
                options.context.errors.sqlite = failure.toString();
                log.error(failure);
                // Note: not cleared here, so a later call is still possible.
                cb?.(error);
            }
            else {
                (0, targz_1.compress)({
                    src: fileNameSQlite,
                    dest: fileName,
                    tar: {
                        map: header => {
                            header.name = fileNameSQlite.split('/').pop();
                            return header;
                        },
                    },
                }, 
                // lib/targz only ever passes an error; the stdout/stderr parameters the original
                // declared here were always undefined.
                async (err) => {
                    clearInterval(timer);
                    if (err) {
                        options.context.errors.sqlite = err.toString();
                        cb?.(err);
                    }
                    else {
                        // Start sql Instances
                        if (startAfterBackup) {
                            for (let i = 0; i < enabledInstances.length; i++) {
                                await options.adapter
                                    .setForeignStateAsync(`system.adapter.${enabledInstances[i]}.alive`, true)
                                    .then(() => log.debug(`${enabledInstances[i]} started`))
                                    .catch(e => log.error(`${enabledInstances[i]} not started: ${e}`));
                            }
                        }
                        log.debug(`Backup created: ${fileName}`);
                        options.context.done.push('sqlite');
                        options.context.types.push('sqlite');
                        if ((0, node_fs_1.existsSync)(fileNameSQlite)) {
                            try {
                                await (0, promises_1.unlink)(fileNameSQlite);
                                log.debug('sqlite File deleted!');
                            }
                            catch (e) {
                                log.warn(`sqlite File cannot deleted: ${e}`);
                                // Reports the compress error, which is falsy in this branch -
                                // so this is an extra call with no error, and the success call
                                // below still follows. Kept as found.
                                cb?.(err);
                            }
                        }
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
exports.ignoreErrors = true;
//# sourceMappingURL=30-sqlite.js.map