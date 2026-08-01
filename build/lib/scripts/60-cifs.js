"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const tools_1 = require("../tools");
function copyFiles(dir, fileNames, log, errors, callback) {
    if (!fileNames || !fileNames.length) {
        callback?.();
    }
    else {
        let fileName = fileNames.shift();
        fileName = fileName.replace(/\\/g, '/');
        const onlyFileName = fileName.split('/').pop();
        try {
            log.debug(`Copy ${onlyFileName}...`);
            (0, tools_1.copyFile)(fileName, (0, node_path_1.join)(dir, onlyFileName), err => {
                if (err) {
                    errors.cifs = err;
                    log.error(err);
                }
                setImmediate(copyFiles, dir, fileNames, log, errors, callback);
            });
        }
        catch (e) {
            log.error(e);
            errors.cifs = e;
            setImmediate(copyFiles, dir, fileNames, log, errors, callback);
        }
    }
}
function deleteFiles(files, log, errors) {
    try {
        for (let f = 0; f < files.length; f++) {
            log.debug(`delete ${files[f]}`);
            (0, node_fs_1.unlinkSync)(files[f]);
        }
        return true;
    }
    catch (e) {
        errors.cifs = errors.cifs || e;
        log.error(e);
        return undefined;
    }
}
function cleanFiles(dir, options, names, num, log, errors) {
    if (!num) {
        return;
    }
    try {
        if (dir[dir.length - 1] !== '/') {
            dir += '/';
        }
        const result = (0, node_fs_1.readdirSync)(dir);
        if (result && result.length) {
            const files = [];
            names.forEach(name => {
                const subResult = result.filter(a => a.startsWith(name));
                let numDel = num;
                // Multi-instance setups produce one file per configured target per run.
                if (name === 'influxDB' && options.influxDBMulti) {
                    numDel = num * options.influxDBEvents.length;
                }
                if (name === 'mysql' && options.mySqlMulti) {
                    numDel = num * options.mySqlEvents.length;
                }
                if (name === 'pgsql' && options.pgSqlMulti) {
                    numDel = num * options.pgSqlEvents.length;
                }
                if (name === 'homematic' && options.ccuMulti) {
                    numDel = num * options.ccuEvents.length;
                }
                if (subResult.length > numDel) {
                    // delete oldest files
                    subResult.sort((a, b) => {
                        const at = (0, node_fs_1.statSync)(dir + a).ctime;
                        const bt = (0, node_fs_1.statSync)(dir + b).ctime;
                        if (at > bt) {
                            return -1;
                        }
                        if (at < bt) {
                            return 1;
                        }
                        return 0;
                    });
                    for (let i = numDel; i < subResult.length; i++) {
                        files.push((0, node_path_1.join)(dir, subResult[i]));
                    }
                }
            });
            deleteFiles(files, log, errors);
        }
    }
    catch (e) {
        errors.cifs = errors.cifs || e;
    }
}
function command(options, log, callback) {
    if (options.dir && options.context && options.context.fileNames && options.context.fileNames.length) {
        const fileNames = JSON.parse(JSON.stringify(options.context.fileNames));
        let dir = options.dir.replace(/\\/g, '/');
        if (dir[0] !== '/' && !dir.match(/\w:/)) {
            dir = `/${dir || ''}`;
        }
        log.debug(`used copy path: ${dir}`);
        let cb = callback;
        if ((0, node_fs_1.existsSync)(dir)) {
            if (dir === options.backupDir) {
                cb?.(`The storage path "${dir}" for copying is not configured correctly`);
            }
            else {
                copyFiles(dir, fileNames, log, options.context.errors, err => {
                    if (err) {
                        log.error(err);
                        options.context.errors.cifs = options.context.errors.cifs || err;
                    }
                    if (options.deleteOldBackup === true) {
                        // The original wraps this call in `if (…)` with its own TODO noting that
                        // cleanFiles returns nothing - so the condition is always false and 'cifs'
                        // is never recorded as done on this path. The dead branch is dropped here;
                        // the call and its effect are unchanged.
                        cleanFiles(dir, options, options.context.types, options.deleteBackupAfter, log, options.context.errors);
                    }
                    else if (!options.context.errors.cifs) {
                        options.context.done.push('cifs');
                    }
                    if (cb) {
                        cb(err);
                        cb = undefined;
                    }
                });
            }
        }
        else if (options.mountType === 'Copy') {
            cb?.(`Path "${dir}" not found`);
        }
        else {
            cb?.();
        }
    }
    else {
        callback?.();
    }
}
exports.ignoreErrors = true;
//# sourceMappingURL=60-cifs.js.map