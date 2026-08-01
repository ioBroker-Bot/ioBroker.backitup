"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const ftp_1 = __importDefault(require("ftp"));
function uploadFiles(client, dir, fileNames, log, errors, callback) {
    if (!fileNames || !fileNames.length) {
        callback?.();
    }
    else {
        let fileName = fileNames.shift();
        fileName = fileName.replace(/\\/g, '/');
        const onlyFileName = fileName.split('/').pop();
        log.debug(`Send ${onlyFileName}`);
        if ((0, node_fs_1.existsSync)(fileName)) {
            client.put(fileName, `${dir}/${onlyFileName}`, err => {
                if (err) {
                    errors.ftp = err;
                    log.error(err);
                }
                setImmediate(uploadFiles, client, dir, fileNames, log, errors, callback);
            });
        }
        else {
            log.error(`File "${fileName}" not found`);
            setImmediate(uploadFiles, client, dir, fileNames, log, errors, callback);
        }
    }
}
function deleteFiles(client, files, log, errors, callback) {
    if (!files || !files.length) {
        callback?.();
    }
    else {
        log.debug(`delete ${files[0]}`);
        const file = files.shift();
        try {
            client.delete(file, err => {
                if (err) {
                    log.error(err);
                }
                setImmediate(deleteFiles, client, files, log, errors, callback);
            });
        }
        catch (e) {
            log.error(e);
            setImmediate(deleteFiles, client, files, log, errors, callback);
        }
    }
}
function cleanFiles(client, options, dir, names, num, log, errors, callback) {
    if (!num) {
        callback?.();
        return;
    }
    try {
        if (dir[dir.length - 1] !== '/') {
            dir += '/';
        }
        client.list(dir, (err, result) => {
            if (err) {
                errors.ftp = errors.ftp || err;
            }
            if (names && result && result.length) {
                const files = [];
                names.forEach(name => {
                    if (name) {
                        let subResult;
                        try {
                            subResult = result.filter(a => a.name.startsWith(name));
                        }
                        catch (e) {
                            log.error(`FTP error: ${e}`);
                        }
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
                        if (subResult && subResult.length > numDel) {
                            // delete oldest files
                            subResult.sort((a, b) => {
                                const at = new Date(a.date).getTime();
                                const bt = new Date(b.date).getTime();
                                if (at > bt) {
                                    return -1;
                                }
                                if (at < bt) {
                                    return 1;
                                }
                                return 0;
                            });
                            for (let i = numDel; i < subResult.length; i++) {
                                files.push(dir + subResult[i].name);
                            }
                        }
                    }
                });
                deleteFiles(client, files, log, errors, callback);
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
function command(options, log, callback) {
    if (options.host && options.context && options.context.fileNames && options.context.fileNames.length) {
        const client = new ftp_1.default();
        const fileNames = JSON.parse(JSON.stringify(options.context.fileNames));
        // Note: this writes back onto the shared options object.
        if (!options.dir.startsWith('/')) {
            options.dir = `/${options.dir}`;
        }
        let dir = (options.dir || '').replace(/\\/g, '/');
        if (!dir || dir[0] !== '/') {
            dir = `/${dir || ''}`;
        }
        let cb = callback;
        client.on('ready', () => {
            log.debug('FTP connected.');
            uploadFiles(client, dir, fileNames, log, options.context.errors, () => {
                if (options.deleteOldBackup === true) {
                    const ftpDeleteAfter = options.advancedDelete === false ? options.deleteBackupAfter : options.ftpDeleteAfter;
                    cleanFiles(client, options, dir, options.context.types, ftpDeleteAfter, log, options.context.errors, err => {
                        if (err) {
                            options.context.errors.ftp = options.context.errors.ftp || err;
                        }
                        else {
                            options.context.done.push('ftp');
                        }
                        client.end();
                        if (cb) {
                            cb(err);
                            cb = undefined;
                        }
                    });
                }
                else {
                    client.end();
                    if (!options.context.errors.ftp) {
                        options.context.done.push('ftp');
                    }
                    cb?.();
                }
            });
        });
        client.on('error', err => {
            options.context.errors.ftp = err;
            if (cb) {
                cb(err);
                cb = undefined;
            }
        });
        client.connect({
            host: options.host,
            port: options.port || 21,
            secure: !!options.secure || false,
            // As in lib/list/ftp: `!!x || true` is always true, so the "allow only signed
            // certificates" setting has never had any effect here. Left as found - making the flag
            // work would silently switch off certificate checking for everyone who unticked it.
            secureOptions: { rejectUnauthorized: !!options.signedCertificates || true },
            user: options.user,
            password: options.pass,
        });
    }
    else {
        callback?.();
    }
}
exports.ignoreErrors = true;
//# sourceMappingURL=50-ftp.js.map