import { exec } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';

import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface UmountOptions {
    context: BackItUpExecuteContext;
    mount: string;
    mountType: 'CIFS' | 'NFS' | 'Copy' | 'Expert';
    backupDir: string;
    fileDir: string;
    sudo?: boolean;
}

/**
 * Drops the marker file that records an active mount
 *
 * @param options resolved storage settings
 * @param log adapter logger
 */
function dropMountMarker(options: UmountOptions, log: ioBroker.Logger): void {
    try {
        if (existsSync(`${options.fileDir}/.mount`)) {
            unlinkSync(`${options.fileDir}/.mount`);
        }
    } catch (e) {
        log.warn(`file ".mount" cannot deleted: ${e}`);
    }
}

export function command(options: UmountOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    if (!options.mount) {
        callback?.('NO mount path specified!');
        return;
    }
    if (options.mountType === 'CIFS' || options.mountType === 'NFS' || options.mountType === 'Expert') {
        // Note: when the marker file is absent nothing runs and the callback is never invoked.
        if (existsSync(`${options.fileDir}/.mount`)) {
            exec(`mount | grep -o "${options.backupDir}"`, (_error, stdout) => {
                if (stdout.includes(options.backupDir)) {
                    log.debug('mount active, umount is started ...');
                    setTimeout(() => {
                        exec(
                            `${options.sudo ? 'sudo umount' : 'umount'} ${options.backupDir}`,
                            (error, umountStdout) => {
                                if (error) {
                                    log.debug('device is busy... wait 2 Minutes!!');
                                    setTimeout(() => {
                                        exec(
                                            `${options.sudo ? 'sudo umount' : 'umount'} -l ${options.backupDir}`,
                                            (lazyError, lazyStdout, lazyStderr) => {
                                                if (lazyError) {
                                                    options.context.errors.umount = lazyError;
                                                    log.error(lazyStderr);
                                                    callback?.(lazyError);
                                                } else {
                                                    options.context.done.push('umount');
                                                    log.debug('umount successfully completed');
                                                    dropMountMarker(options, log);
                                                    callback?.(null, lazyStdout);
                                                }
                                            },
                                        );
                                    }, 120000);
                                } else {
                                    options.context.done.push('umount');
                                    log.debug('umount successfully completed');
                                    dropMountMarker(options, log);
                                    callback?.(null, umountStdout);
                                }
                            },
                        );
                    }, 5000);
                } else {
                    options.context.done.push('umount');
                    log.debug('mount inactive, umount not started ...');
                    dropMountMarker(options, log);
                    callback?.(null);
                }
            });
        }
    } else {
        callback?.(null);
    }
}

export const ignoreErrors = true;
