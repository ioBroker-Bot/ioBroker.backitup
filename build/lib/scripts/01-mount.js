"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_wol_1 = require("node-wol");
/**
 * Drops the marker file that records an active mount
 *
 * @param options resolved storage settings
 * @param log adapter logger
 */
function dropMountMarker(options, log) {
    try {
        if ((0, node_fs_1.existsSync)(`${options.fileDir}/.mount`)) {
            (0, node_fs_1.unlinkSync)(`${options.fileDir}/.mount`);
        }
    }
    catch (e) {
        log.warn(`file ".mount" cannot deleted: ${e}`);
    }
}
/**
 * Writes the marker file that records an active mount
 *
 * @param options resolved storage settings
 * @param log adapter logger
 */
function writeMountMarker(options, log) {
    try {
        (0, node_fs_1.writeFileSync)(`${options.fileDir}/.mount`, options.mountType);
    }
    catch (e) {
        log.warn(`file ".mount" cannot created: ${e}`);
    }
}
function command(options, log, callback) {
    let waitTime = 10000;
    // The `=== 'true'` arms look redundant against the declared boolean types, but instance
    // configurations written by older versions really do carry the strings.
    const wakeOnLan = options.wakeOnLAN === 'true' || options.wakeOnLAN === true;
    const wolExtra = options.wolExtra === 'true' || options.wolExtra === true;
    if (wakeOnLan) {
        (0, node_wol_1.wake)(options.macAd, {
            address: wolExtra ? options.mount : '255.255.255.255',
            port: wolExtra ? options.wolPort : 9,
        }, error => {
            if (error) {
                log.error(error);
                callback?.('NO Wake on LAN specified!');
                return;
            }
            log.debug(`Wake on LAN MAC-Address: ${options.macAd}`);
        });
        waitTime = options.wolTime * 1000;
        log.debug(`Wake on LAN wait ${options.wolTime} Seconds for NAS!`);
    }
    if (options.mountType === 'CIFS' && options.mount && !options.mount.startsWith('//')) {
        options.mount = `//${options.mount}`;
    }
    if ((options.mountType === 'CIFS' && options.mount && !options.dir.startsWith('/')) ||
        (options.mountType === 'NFS' && options.mount && !options.dir.startsWith('/'))) {
        options.dir = `/${options.dir}`;
    }
    // Note the asymmetry in the second clause - unlike lib/list/cifs this one tests
    // `options.pass.endsWith("'")` without negating it. Kept as found.
    if ((!options.pass.startsWith(`"`) || !options.pass.endsWith(`"`)) &&
        (!options.pass.startsWith(`'`) || options.pass.endsWith(`'`))) {
        options.pass = `"${options.pass}"`;
    }
    if (!options.mount) {
        callback?.('NO mount path specified!');
        return;
    }
    if (options.mountType === 'CIFS' || options.mountType === 'NFS' || options.mountType === 'Expert') {
        if ((0, node_fs_1.existsSync)(`${options.fileDir}/.mount`)) {
            (0, node_child_process_1.exec)(`mount | grep -o "${options.backupDir}"`, (_error, stdout) => {
                if (stdout.includes(options.backupDir)) {
                    log.debug('mount activ... umount is started before mount!!');
                    (0, node_child_process_1.exec)(`${options.sudo ? 'sudo umount' : 'umount'} ${options.backupDir}`, error => {
                        if (error) {
                            log.debug('device is busy... wait 2 Minutes!!');
                            setTimeout(() => {
                                (0, node_child_process_1.exec)(`${options.sudo ? 'sudo umount' : 'umount'} ${options.backupDir}`, (retryError, _retryStdout, retryStderr) => {
                                    if (retryError) {
                                        options.context.errors.umount = retryError;
                                        log.error(retryStderr);
                                    }
                                    else {
                                        options.context.done.push('umount');
                                        log.debug('umount successfully completed');
                                        dropMountMarker(options, log);
                                    }
                                });
                            }, 120000);
                        }
                        else {
                            options.context.done.push('umount');
                            log.debug('umount successfully completed');
                            dropMountMarker(options, log);
                        }
                    });
                }
            });
        }
    }
    if (options.mountType === 'CIFS') {
        const common = `${options.cifsDomain ? `,domain=${options.cifsDomain}` : ''}` +
            `${options.clientInodes ? ',noserverino' : ''}` +
            `${options.cacheLoose ? ',cache=loose' : ''}` +
            `,rw,forceuid,uid=iobroker,forcegid,gid=iobroker,file_mode=0777,dir_mode=0777`;
        const credentials = options.user ? `username=${options.user},password=${options.pass}` : '';
        const masked = options.user ? `username=${options.user},password=****` : '';
        const mountCmd = `${options.sudo ? 'sudo mount' : 'mount'} -t cifs -o `;
        const target = ` ${options.mount}${options.dir} ${options.backupDir}`;
        setTimeout(() => {
            log.debug(`cifs-mount command: "${mountCmd}${masked}${common},${options.smb}${target}"`);
            (0, node_child_process_1.exec)(`${mountCmd}${credentials}${common},${options.smb}${target}`, (error, stdout) => {
                if (error) {
                    log.debug('first mount attempt with smb option failed. try next mount attempt without smb option ...');
                    log.debug(`cifs-mount command: "${mountCmd}${masked}${common}${target}"`);
                    (0, node_child_process_1.exec)(`${mountCmd}${credentials}${common}${target}`, (retryError, retryStdout) => {
                        if (retryError) {
                            // `ExecException` is declared as Omit<ErrnoException, 'code'>, which drops
                            // the nominal Error identity; binding it back keeps the formatting equal.
                            const failure = retryError;
                            let errLog = String(failure);
                            try {
                                const formatPass = options.pass.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                                errLog = errLog.replace(new RegExp(formatPass, 'g'), '****');
                            }
                            catch {
                                // ignore
                            }
                            options.context.errors.mount = retryError;
                            log.error(`[${options.name} ${errLog}`);
                            callback?.(null, errLog);
                        }
                        else {
                            log.debug('mount successfully completed');
                            options.context.done.push('mount');
                            writeMountMarker(options, log);
                            callback?.(null, retryStdout);
                        }
                    });
                }
                else {
                    log.debug('mount successfully completed');
                    options.context.done.push('mount');
                    // Unlike every other branch this write is not guarded by a try/catch.
                    (0, node_fs_1.writeFileSync)(`${options.fileDir}/.mount`, options.mountType);
                    callback?.(null, stdout);
                }
            });
        }, waitTime);
    }
    if (options.mountType === 'NFS') {
        setTimeout(() => {
            log.debug(`nfs-mount command: "${options.sudo ? 'sudo mount' : 'mount'} ${options.mount}:${options.dir} ${options.backupDir}"`);
            (0, node_child_process_1.exec)(`${options.sudo ? 'sudo mount' : 'mount'} ${options.mount}:${options.dir} ${options.backupDir}`, (error, stdout, stderr) => {
                if (error) {
                    options.context.errors.mount = error;
                    log.error(`[${options.name} ${stderr}`);
                    // The Error travels in the stdout slot here, as before.
                    callback?.(null, error);
                }
                else {
                    log.debug('mount successfully completed');
                    options.context.done.push('mount');
                    writeMountMarker(options, log);
                    callback?.(null, stdout);
                }
            });
        }, waitTime);
    }
    if (options.mountType === 'Expert') {
        setTimeout(() => {
            log.debug(`expert-mount command: "${options.expertMount}"`);
            (0, node_child_process_1.exec)(options.expertMount, (error, stdout, stderr) => {
                if (error) {
                    options.context.errors.mount = error;
                    log.error(`[${options.name} ${stderr}`);
                    callback?.(null, error);
                }
                else {
                    log.debug('expert-mount successfully completed');
                    options.context.done.push('mount');
                    writeMountMarker(options, log);
                    callback?.(null, stdout);
                }
            });
        }, waitTime);
    }
    if (options.mountType === 'Copy') {
        callback?.(null);
    }
}
exports.ignoreErrors = true;
//# sourceMappingURL=01-mount.js.map