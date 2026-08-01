"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
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
function command(options, log, callback) {
    if (!options.mount) {
        callback?.('NO mount path specified!');
        return;
    }
    if (options.mountType === 'CIFS' || options.mountType === 'NFS' || options.mountType === 'Expert') {
        // Note: when the marker file is absent nothing runs and the callback is never invoked.
        if ((0, node_fs_1.existsSync)(`${options.fileDir}/.mount`)) {
            (0, node_child_process_1.exec)(`mount | grep -o "${options.backupDir}"`, (_error, stdout) => {
                if (stdout.includes(options.backupDir)) {
                    log.debug('mount active, umount is started ...');
                    setTimeout(() => {
                        (0, node_child_process_1.exec)(`${options.sudo ? 'sudo umount' : 'umount'} ${options.backupDir}`, (error, umountStdout) => {
                            if (error) {
                                log.debug('device is busy... wait 2 Minutes!!');
                                setTimeout(() => {
                                    (0, node_child_process_1.exec)(`${options.sudo ? 'sudo umount' : 'umount'} -l ${options.backupDir}`, (lazyError, lazyStdout, lazyStderr) => {
                                        if (lazyError) {
                                            options.context.errors.umount = lazyError;
                                            log.error(lazyStderr);
                                            callback?.(lazyError);
                                        }
                                        else {
                                            options.context.done.push('umount');
                                            log.debug('umount successfully completed');
                                            dropMountMarker(options, log);
                                            callback?.(null, lazyStdout);
                                        }
                                    });
                                }, 120000);
                            }
                            else {
                                options.context.done.push('umount');
                                log.debug('umount successfully completed');
                                dropMountMarker(options, log);
                                callback?.(null, umountStdout);
                            }
                        });
                    }, 5000);
                }
                else {
                    options.context.done.push('umount');
                    log.debug('mount inactive, umount not started ...');
                    dropMountMarker(options, log);
                    callback?.(null);
                }
            });
        }
    }
    else {
        callback?.(null);
    }
}
exports.ignoreErrors = true;
//# sourceMappingURL=94-umount.js.map