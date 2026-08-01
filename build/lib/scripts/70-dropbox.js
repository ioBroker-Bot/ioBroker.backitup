"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const dropbox_v2_api_1 = require("dropbox-v2-api");
const dropboxLib_1 = __importDefault(require("../dropboxLib"));
/** Files above this size go through a chunked upload session */
const SINGLE_SHOT_LIMIT_MB = 100;
async function copyFiles(dbx, dropbox, dir, fileNames, log, errors, callback) {
    if (!fileNames || !fileNames.length) {
        callback?.();
    }
    else {
        let fileName;
        try {
            fileName = fileNames.shift();
            fileName = fileName.replace(/\\/g, '/');
            const onlyFileName = fileName.split('/').pop();
            if ((0, node_fs_1.existsSync)(fileName)) {
                log.debug(`Dropbox: Copy ${onlyFileName}...`);
                const fileSize = (0, node_fs_1.statSync)(fileName).size;
                if (fileSize && Math.round((fileSize / (1024 * 1024)) * 10) / 10 <= SINGLE_SHOT_LIMIT_MB) {
                    const readStream = (0, node_fs_1.createReadStream)(fileName);
                    readStream.on('error', err => {
                        log.error(`readStream Dropbox: ${err}`);
                    });
                    dbx({
                        resource: 'files/upload',
                        parameters: {
                            path: (0, node_path_1.join)(dir, onlyFileName).replace(/\\/g, '/'),
                        },
                        readStream,
                    }, err => {
                        try {
                            if (err) {
                                errors.dropbox = JSON.stringify(err);
                                log.error(`upload Dropbox: ${JSON.stringify(err)}`);
                            }
                            setImmediate(copyFiles, dbx, dropbox, dir, fileNames, log, errors, callback);
                        }
                        catch (e) {
                            errors.dropbox = e;
                            log.error(`Dropbox callback error: ${JSON.stringify(e)}`);
                            setImmediate(copyFiles, dbx, dropbox, dir, fileNames, log, errors, callback);
                        }
                    });
                }
                else if (fileSize && Math.round((fileSize / (1024 * 1024)) * 10) / 10 > SINGLE_SHOT_LIMIT_MB) {
                    try {
                        await dropbox.sessionUpload(dbx, fileName, dir, log);
                    }
                    catch (e) {
                        errors.dropbox = e;
                        log.error(`Dropbox sessionUpload: ${JSON.stringify(e)}`);
                    }
                    setImmediate(copyFiles, dbx, dropbox, dir, fileNames, log, errors, callback);
                }
                // Note: a zero-byte file matches neither branch, so the walk stops there.
            }
            else {
                log.error(`Dropbox: File "${fileName}" not found`);
                setImmediate(copyFiles, dbx, dropbox, dir, fileNames, log, errors, callback);
            }
        }
        catch (e) {
            errors.dropbox = e;
            log.error(`Dropbox: ${JSON.stringify(e)}`);
            setImmediate(copyFiles, dbx, dropbox, dir, fileNames, log, errors, callback);
        }
    }
}
function deleteFiles(dbx, files, log, errors, callback) {
    if (!files || !files.length) {
        callback?.();
    }
    else {
        log.debug(`Dropbox: delete ${files[0]}`);
        try {
            dbx({
                resource: 'files/delete',
                parameters: {
                    path: files.shift(),
                },
            }, err => {
                if (err) {
                    log.error(`Dropbox: ${JSON.stringify(err)}`);
                }
                setImmediate(deleteFiles, dbx, files, log, errors, callback);
            });
        }
        catch (e) {
            log.error(`Dropbox: ${JSON.stringify(e)}`);
            // Reports completion and then keeps walking the list - kept as found.
            callback?.();
            setImmediate(deleteFiles, dbx, files, log, errors, callback);
        }
    }
}
function cleanFiles(dbx, options, dir, names, num, log, errors, callback) {
    if (!num) {
        callback?.();
        return;
    }
    try {
        dbx({
            resource: 'files/list_folder',
            parameters: {
                path: dir.replace(/^\/$/, ''),
            },
        }, (err, result) => {
            if (err) {
                log.error(`Dropbox: ${JSON.stringify(err)}`);
            }
            if (result && result.entries) {
                const files = [];
                names.forEach(name => {
                    const subResult = result.entries.filter((a) => a.name.startsWith(name));
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
                            const at = new Date(a.client_modified).getTime();
                            const bt = new Date(b.client_modified).getTime();
                            if (at > bt) {
                                return -1;
                            }
                            if (at < bt) {
                                return 1;
                            }
                            return 0;
                        });
                        for (let i = numDel; i < subResult.length; i++) {
                            files.push(subResult[i].path_display);
                        }
                    }
                });
                deleteFiles(dbx, files, log, errors, callback);
            }
            else {
                callback?.();
            }
        });
    }
    catch (e) {
        callback?.(e);
    }
}
async function command(options, log, callback) {
    const dropbox = new dropboxLib_1.default();
    // Token refresh
    const db_accessToken = options.accessToken || '';
    if (db_accessToken && options.context.fileNames.length) {
        const fileNames = JSON.parse(JSON.stringify(options.context.fileNames));
        const dbx = (0, dropbox_v2_api_1.authenticate)({ token: db_accessToken });
        let dir = (options.dir || '').replace(/\\/g, '/');
        if (!dir || dir[0] !== '/') {
            dir = `/${dir || ''}`;
        }
        void copyFiles(dbx, dropbox, dir, fileNames, log, options.context.errors, err => {
            if (err) {
                options.context.errors.dropbox = err;
                log.error(`Dropbox: ${JSON.stringify(err)}`);
            }
            if (options.deleteOldBackup === true) {
                const dropboxDeleteAfter = options.advancedDelete === false ? options.deleteBackupAfter : options.dropboxDeleteAfter;
                cleanFiles(dbx, options, dir, options.context.types, dropboxDeleteAfter, log, options.context.errors, cleanErr => {
                    if (cleanErr) {
                        options.context.errors.dropbox = options.context.errors.dropbox || cleanErr;
                    }
                    else if (!options.context.errors.dropbox) {
                        options.context.done.push('dropbox');
                    }
                    callback?.(cleanErr);
                });
            }
            else {
                if (!options.context.errors.dropbox) {
                    options.context.done.push('dropbox');
                }
                callback?.(err);
            }
        });
    }
    else {
        callback?.();
    }
}
exports.ignoreErrors = true;
//# sourceMappingURL=70-dropbox.js.map