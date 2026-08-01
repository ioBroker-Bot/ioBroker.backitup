"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const node_https_1 = require("node:https");
const node_path_1 = require("node:path");
async function copyFiles(client, dir, fileNames, log, errors, callback) {
    if (!fileNames || !fileNames.length) {
        callback?.();
    }
    else {
        let fileName = fileNames.shift();
        fileName = fileName.replace(/\\/g, '/');
        const onlyFileName = fileName.split('/').pop();
        if ((0, node_fs_1.existsSync)(fileName)) {
            try {
                const webdavFilename = (0, node_path_1.join)(dir, onlyFileName);
                log.debug(`WebDAV: Copy ${onlyFileName}...`);
                let fileContent = (0, node_fs_1.readFileSync)(fileName);
                // Upload File
                await client
                    .putFileContents(webdavFilename, fileContent, {
                    format: 'binary',
                    'Content-Type': 'application/octet-stream',
                    contentLength: fileContent.length,
                })
                    .then(() => {
                    fileContent = null;
                    setImmediate(copyFiles, client, dir, fileNames, log, errors, callback);
                });
            }
            catch (e) {
                log.error(`WebDAV: ${e}`);
                setImmediate(copyFiles, client, dir, fileNames, log, errors, callback);
            }
        }
        else {
            log.error(`WebDAV: File "${fileName}" not found`);
            setImmediate(copyFiles, client, dir, fileNames, log, errors, callback);
        }
    }
}
function deleteFiles(client, files, log, errors, callback) {
    if (!files || !files.length) {
        callback?.();
    }
    else {
        log.debug(`WebDAV: delete ${files[0]}`);
        const file = files.shift();
        client
            .deleteFile(file)
            .then(() => {
            setImmediate(deleteFiles, client, files, log, errors, callback);
        })
            .catch(err => {
            log.error(`WebDAV: ${err}`);
            setImmediate(deleteFiles, client, files, log, errors, callback);
        });
    }
}
async function cleanFiles(client, options, dir, names, num, log, errors, callback) {
    if (!num) {
        callback?.();
        return;
    }
    try {
        const result = await client.getDirectoryContents(dir.replace(/^\/$/, ''));
        if (result) {
            const files = [];
            names.forEach(name => {
                const subResult = result.filter(a => a.basename.startsWith(name));
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
                        const at = new Date(a.lastmod).getTime();
                        const bt = new Date(b.lastmod).getTime();
                        if (at > bt) {
                            return -1;
                        }
                        if (at < bt) {
                            return 1;
                        }
                        return 0;
                    });
                    for (let i = numDel; i < subResult.length; i++) {
                        files.push(subResult[i].filename);
                    }
                }
            });
            deleteFiles(client, files, log, errors, callback);
        }
        else {
            callback?.();
        }
    }
    catch (e) {
        callback?.(e);
    }
}
async function command(options, log, callback) {
    if (options.username && options.pass && options.url && options.context.fileNames.length) {
        const fileNames = JSON.parse(JSON.stringify(options.context.fileNames));
        log.debug('Start WebDAV Upload ...');
        let dir = (options.dir || '').replace(/\\/g, '/');
        if (!dir || dir[0] !== '/') {
            dir = `/${dir || ''}`;
        }
        const { createClient } = await import('webdav');
        const agent = new node_https_1.Agent({ rejectUnauthorized: Boolean(options.signedCertificates) });
        let client;
        try {
            client = createClient(options.url, {
                username: options.username,
                password: options.pass,
                maxBodyLength: Infinity,
                httpsAgent: agent,
            });
        }
        catch (err) {
            options.context.errors.webdav = err;
            log.error(`cannot connect to WebDAV: ${err}`);
            // No early return on purpose: the dereference below then throws into the next try, so
            // the callback reports twice. Preserved.
            callback?.();
        }
        try {
            if ((await client.exists(dir)) === false) {
                await client.createDirectory(dir);
            }
        }
        catch (e) {
            log.warn(`cannot created the backup directory: ${e}`);
            options.context.errors.webdav = e;
            callback?.();
        }
        try {
            client
                .getDirectoryContents(dir)
                .then(() => {
                void copyFiles(client, dir, fileNames, log, options.context.errors, err => {
                    if (err) {
                        options.context.errors.webdav = err;
                        log.error(`WebDAV: ${err}`);
                    }
                    if (options.deleteOldBackup === true) {
                        const webdavDeleteAfter = options.advancedDelete === false
                            ? options.deleteBackupAfter
                            : options.webdavDeleteAfter;
                        void cleanFiles(client, options, dir, options.context.types, webdavDeleteAfter, log, options.context.errors, cleanErr => {
                            if (cleanErr) {
                                options.context.errors.webdav =
                                    options.context.errors.webdav || cleanErr;
                                callback?.(cleanErr);
                            }
                            else {
                                if (!options.context.errors.webdav) {
                                    options.context.done.push('webdav');
                                }
                                callback?.();
                            }
                        });
                    }
                    else {
                        if (!options.context.errors.webdav) {
                            options.context.done.push('webdav');
                        }
                        callback?.();
                    }
                });
            })
                .catch(err => {
                log.error(`cannot connect to WebDAV: ${err}`);
                options.context.errors.webdav = err;
                callback?.(err);
            });
        }
        catch (e) {
            log.error(`Error WebDAV-Upload: ${e}`);
            options.context.errors.webdav = e;
            callback?.(e);
        }
    }
    else {
        callback?.();
    }
}
exports.ignoreErrors = true;
//# sourceMappingURL=65-webdav.js.map