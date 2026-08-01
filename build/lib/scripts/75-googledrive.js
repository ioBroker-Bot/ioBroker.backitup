"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const googleDriveLib_1 = __importDefault(require("../googleDriveLib"));
function copyFiles(gDrive, dir, fileNames, log, errors, callback) {
    if (!fileNames || !fileNames.length) {
        callback?.();
    }
    else {
        let fileName = fileNames.shift();
        fileName = fileName.replace(/\\/g, '/');
        const onlyFileName = fileName.split('/').pop();
        if ((0, node_fs_1.existsSync)(fileName)) {
            gDrive
                .createFolder(dir, log)
                .then(folderId => {
                const readStream = (0, node_fs_1.createReadStream)(fileName);
                readStream.on('error', err => {
                    if (err) {
                        log.error(`Google Drive: ${err}`);
                    }
                });
                log.debug(`Google Drive: Copy ${onlyFileName}...`);
                // Note: on a write failure this schedules the next file here, and the `.then`
                // below schedules it again - the walk then advances twice. Kept as found.
                return gDrive.writeFile(folderId, onlyFileName, readStream, log).catch(err => {
                    log.error(`Google Drive writeFile failed: ${err}`);
                    setTimeout(copyFiles, 150, gDrive, dir, fileNames, log, errors, callback);
                });
            })
                .then(() => setTimeout(copyFiles, 150, gDrive, dir, fileNames, log, errors, callback))
                .catch(err => {
                log.error(`Google Drive writeFile Error: ${err}`);
                setTimeout(copyFiles, 150, gDrive, dir, fileNames, log, errors, callback);
            });
        }
        else {
            log.error(`Google Drive: File "${fileName}" not found`);
            setTimeout(copyFiles, 150, gDrive, dir, fileNames, log, errors, callback);
        }
    }
}
function deleteFiles(gDrive, fileIds, fileNames, log, errors, callback) {
    if ((!fileIds || !fileIds.length) && (!fileNames || !fileNames.length)) {
        callback?.();
    }
    else {
        const fileId = fileIds.shift();
        const fileName = fileNames.shift();
        log.debug(`Google Drive: delete ${fileName}`);
        gDrive
            .deleteFile(fileId)
            .then(() => setTimeout(deleteFiles, 150, gDrive, fileIds, fileNames, log, errors, callback))
            .catch(err => {
            if (err) {
                log.error(`Google Drive: ${err}`);
            }
            setTimeout(deleteFiles, 150, gDrive, fileIds, fileNames, log, errors, callback);
        });
    }
}
function cleanFiles(gDrive, options, dir, names, num, log, errors, callback) {
    if (!num) {
        callback?.();
        return;
    }
    gDrive
        .getFileOrFolderId(dir)
        .then(folderId => gDrive.listFilesInFolder(folderId))
        .then(result => {
        if (result && result.length) {
            const fileIds = [];
            const fileNames = [];
            names.forEach(name => {
                const subResult = result.filter(a => a.name.startsWith(name));
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
                // sort files
                if (subResult.length > numDel) {
                    // delete oldest files
                    subResult.sort((a, b) => {
                        const at = new Date(a.modifiedTime).getTime();
                        const bt = new Date(b.modifiedTime).getTime();
                        if (at > bt) {
                            return -1;
                        }
                        if (at < bt) {
                            return 1;
                        }
                        return 0;
                    });
                    for (let i = numDel; i < subResult.length; i++) {
                        fileIds.push(subResult[i].id);
                        fileNames.push(subResult[i].name);
                    }
                }
            });
            deleteFiles(gDrive, fileIds, fileNames, log, errors, callback);
        }
        else {
            callback?.();
        }
    })
        .catch(err => {
        log.error(`Google Drive: ${err}`);
        callback?.(err);
    });
}
function command(options, log, callback) {
    if (options.accessJson && options.context.fileNames.length) {
        const fileNames = JSON.parse(JSON.stringify(options.context.fileNames));
        const gDrive = new googleDriveLib_1.default(options.accessJson, options.newToken);
        if (!gDrive) {
            callback?.('No or invalid access key');
            return;
        }
        let dir = (options.dir || '').replace(/\\/g, '/');
        if (!dir || dir[0] !== '/') {
            dir = `/${dir || ''}`;
        }
        copyFiles(gDrive, dir, fileNames, log, options.context.errors, err => {
            if (err) {
                options.context.errors.googledrive = err;
                log.error(`Google Drive: ${err}`);
            }
            if (options.deleteOldBackup === true) {
                const googledriveDeleteAfter = options.advancedDelete === false ? options.deleteBackupAfter : options.googledriveDeleteAfter;
                cleanFiles(gDrive, options, dir, options.context.types, googledriveDeleteAfter, log, options.context.errors, cleanErr => {
                    if (cleanErr) {
                        options.context.errors.googledrive = options.context.errors.googledrive || cleanErr;
                    }
                    else if (!options.context.errors.googledrive) {
                        options.context.done.push('googledrive');
                    }
                    callback?.(cleanErr);
                });
            }
            else {
                if (!options.context.errors.googledrive) {
                    options.context.done.push('googledrive');
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
//# sourceMappingURL=75-googledrive.js.map