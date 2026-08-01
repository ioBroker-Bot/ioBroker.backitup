"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.list = list;
exports.getFile = getFile;
const node_fs_1 = require("node:fs");
const node_https_1 = require("node:https");
function settings(options) {
    return {
        username: options.username !== undefined
            ? options.username
            : options.webdav && options.webdav.username !== undefined
                ? options.webdav.username
                : '',
        pass: options.pass !== undefined
            ? options.pass
            : options.webdav && options.webdav.pass !== undefined
                ? options.webdav.pass
                : '',
        url: options.url !== undefined
            ? options.url
            : options.webdav && options.webdav.url !== undefined
                ? options.webdav.url
                : '',
        dir: options.dir !== undefined
            ? options.dir
            : options.webdav && options.webdav.dir !== undefined
                ? options.webdav.dir
                : '/',
        dirMinimal: options.dirMinimal !== undefined
            ? options.dirMinimal
            : options.webdav && options.webdav.dirMinimal !== undefined
                ? options.webdav.dirMinimal
                : '/',
        ownDir: options.ownDir !== undefined
            ? options.ownDir
            : options.webdav && options.webdav.ownDir !== undefined
                ? options.webdav.ownDir
                : false,
        signedCertificates: options.signedCertificates !== undefined
            ? options.signedCertificates
            : options.webdav && options.webdav.signedCertificates !== undefined
                ? options.webdav.signedCertificates
                : true,
    };
}
/**
 * Applies the "own directory" switch and makes sure the path is absolute
 *
 * @param dir configured target directory
 * @param ownDir whether the minimal backup uses its own directory
 * @param dirMinimal directory used when `ownDir` is set
 */
function targetDir(dir, ownDir, dirMinimal) {
    let result = (dir || '').replace(/\\/g, '/');
    if (ownDir === true) {
        result = (dirMinimal || '').replace(/\\/g, '/');
    }
    if (!result || result[0] !== '/') {
        result = `/${result || ''}`;
    }
    return result;
}
async function list(restoreSource, options, types, log, callback) {
    try {
        const cfg = settings(options);
        if (cfg.username && cfg.pass && cfg.url && (!restoreSource || restoreSource === 'webdav')) {
            // webdav is ESM only, so it has to be pulled in with a dynamic import
            const { createClient } = await import('webdav');
            const agent = new node_https_1.Agent({ rejectUnauthorized: Boolean(cfg.signedCertificates) });
            let client;
            try {
                client = createClient(cfg.url, {
                    username: cfg.username,
                    password: cfg.pass,
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                    httpsAgent: agent,
                });
            }
            catch (err) {
                log.error(`cannot conntect to WebDAV: ${err}`);
                callback?.();
                // No early return on purpose: the code below then dereferences the client that was
                // never created, the resulting TypeError is caught by the try that follows, and the
                // callback fires a second time - this time with that error. Preserved.
            }
            const dir = targetDir(cfg.dir, cfg.ownDir, cfg.dirMinimal);
            try {
                client
                    .getDirectoryContents(dir)
                    .then(contents => {
                    if (contents) {
                        const entries = contents
                            .map(file => ({
                            path: file.filename,
                            name: file.filename.replace(/\\/g, '/').split('/').pop(),
                            size: file.size,
                        }))
                            .filter(file => (types.indexOf(file.name.split('_')[0]) !== -1 ||
                            types.indexOf(file.name.split('.')[0]) !== -1) &&
                            file.name.split('.').pop() == 'gz');
                        const files = {};
                        entries.forEach(file => {
                            const type = file.name.split('_')[0];
                            files[type] = files[type] || [];
                            files[type].push(file);
                        });
                        callback?.(null, files, 'webdav');
                    }
                    else {
                        callback?.();
                    }
                })
                    .catch(err => {
                    log.error(`cannot conntect to WebDAV: ${err}`);
                    callback?.();
                });
            }
            catch (e) {
                setImmediate(() => callback?.(e));
            }
        }
        else {
            setImmediate(() => callback?.());
        }
    }
    catch (err) {
        log.error(`WebDAV: ${err}`);
        callback?.();
    }
}
async function getFile(options, fileName, toStoreName, log, callback) {
    const cfg = settings(options);
    if (cfg.username && cfg.pass && cfg.url) {
        // webdav is ESM only, so it has to be pulled in with a dynamic import
        const { createClient } = await import('webdav');
        // Note: unlike in `list` the flag is passed through without Boolean() - kept as it was.
        const agent = new node_https_1.Agent({ rejectUnauthorized: cfg.signedCertificates });
        // copy file to backupDir
        let client;
        try {
            client = createClient(cfg.url, {
                username: cfg.username,
                password: cfg.pass,
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                httpsAgent: agent,
            });
        }
        catch (err) {
            log.error(`cannot conntect to WebDAV: ${err}`);
            callback?.();
            // As above: no early return, the following dereference throws into the try below.
        }
        try {
            log.debug(`WebDAV: Download of "${fileName}" started`);
            // Fires at most once, whichever of the two stream events comes first.
            let done = callback;
            const finish = (err) => {
                if (done) {
                    const fire = done;
                    done = undefined;
                    fire(err);
                }
            };
            const writeStream = (0, node_fs_1.createWriteStream)(toStoreName);
            writeStream
                .on('error', err => {
                log.error(`WebDAV: ${err}`);
                finish(err);
            })
                .on('close', () => {
                log.debug(`WebDAV: Download of "${fileName}" finish`);
                finish();
            });
            client.createReadStream(fileName).pipe(writeStream);
        }
        catch (e) {
            log.debug(String(e));
            if (callback) {
                setImmediate(() => callback(e));
            }
        }
    }
    else if (callback) {
        setImmediate(() => callback('Not configured'));
    }
}
//# sourceMappingURL=webdav.js.map