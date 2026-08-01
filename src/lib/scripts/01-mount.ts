import { exec } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { wake } from 'node-wol';

import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface MountOptions {
    context: BackItUpExecuteContext;
    name?: string;
    mount: string;
    mountType: 'CIFS' | 'NFS' | 'Copy' | 'Expert';
    dir: string;
    backupDir: string;
    fileDir: string;
    pass: string;
    user?: string;
    sudo?: boolean;
    smb?: string;
    cifsDomain?: string;
    clientInodes?: boolean;
    cacheLoose?: boolean;
    expertMount: string;
    wakeOnLAN?: boolean;
    macAd?: string;
    wolExtra?: boolean;
    wolPort?: number;
    wolTime?: number;
}

/**
 * Drops the marker file that records an active mount
 *
 * @param options resolved storage settings
 * @param log adapter logger
 */
function dropMountMarker(options: MountOptions, log: ioBroker.Logger): void {
    try {
        if (existsSync(`${options.fileDir}/.mount`)) {
            unlinkSync(`${options.fileDir}/.mount`);
        }
    } catch (e) {
        log.warn(`file ".mount" cannot deleted: ${e}`);
    }
}

/**
 * Writes the marker file that records an active mount
 *
 * @param options resolved storage settings
 * @param log adapter logger
 */
function writeMountMarker(options: MountOptions, log: ioBroker.Logger): void {
    try {
        writeFileSync(`${options.fileDir}/.mount`, options.mountType);
    } catch (e) {
        log.warn(`file ".mount" cannot created: ${e}`);
    }
}

export function command(options: MountOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    let waitTime = 10000;

    // The `=== 'true'` arms look redundant against the declared boolean types, but instance
    // configurations written by older versions really do carry the strings.
    const wakeOnLan = (options.wakeOnLAN as unknown) === 'true' || options.wakeOnLAN === true;
    const wolExtra = (options.wolExtra as unknown) === 'true' || options.wolExtra === true;

    if (wakeOnLan) {
        wake(
            options.macAd as string,
            {
                address: wolExtra ? options.mount : '255.255.255.255',
                port: wolExtra ? options.wolPort : 9,
            },
            error => {
                if (error) {
                    log.error(error as string);
                    callback?.('NO Wake on LAN specified!');
                    return;
                }
                log.debug(`Wake on LAN MAC-Address: ${options.macAd}`);
            },
        );
        waitTime = (options.wolTime as number) * 1000;

        log.debug(`Wake on LAN wait ${options.wolTime} Seconds for NAS!`);
    }

    if (options.mountType === 'CIFS' && options.mount && !options.mount.startsWith('//')) {
        options.mount = `//${options.mount}`;
    }
    if (
        (options.mountType === 'CIFS' && options.mount && !options.dir.startsWith('/')) ||
        (options.mountType === 'NFS' && options.mount && !options.dir.startsWith('/'))
    ) {
        options.dir = `/${options.dir}`;
    }

    // Note the asymmetry in the second clause - unlike lib/list/cifs this one tests
    // `options.pass.endsWith("'")` without negating it. Kept as found.
    if (
        (!options.pass.startsWith(`"`) || !options.pass.endsWith(`"`)) &&
        (!options.pass.startsWith(`'`) || options.pass.endsWith(`'`))
    ) {
        options.pass = `"${options.pass}"`;
    }

    if (!options.mount) {
        callback?.('NO mount path specified!');
        return;
    }

    if (options.mountType === 'CIFS' || options.mountType === 'NFS' || options.mountType === 'Expert') {
        if (existsSync(`${options.fileDir}/.mount`)) {
            exec(`mount | grep -o "${options.backupDir}"`, (_error, stdout) => {
                if (stdout.includes(options.backupDir)) {
                    log.debug('mount activ... umount is started before mount!!');
                    exec(`${options.sudo ? 'sudo umount' : 'umount'} ${options.backupDir}`, error => {
                        if (error) {
                            log.debug('device is busy... wait 2 Minutes!!');
                            setTimeout(() => {
                                exec(
                                    `${options.sudo ? 'sudo umount' : 'umount'} ${options.backupDir}`,
                                    (retryError, _retryStdout, retryStderr) => {
                                        if (retryError) {
                                            options.context.errors.umount = retryError;
                                            log.error(retryStderr);
                                        } else {
                                            options.context.done.push('umount');
                                            log.debug('umount successfully completed');
                                            dropMountMarker(options, log);
                                        }
                                    },
                                );
                            }, 120000);
                        } else {
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
        const common =
            `${options.cifsDomain ? `,domain=${options.cifsDomain}` : ''}` +
            `${options.clientInodes ? ',noserverino' : ''}` +
            `${options.cacheLoose ? ',cache=loose' : ''}` +
            `,rw,forceuid,uid=iobroker,forcegid,gid=iobroker,file_mode=0777,dir_mode=0777`;
        const credentials = options.user ? `username=${options.user},password=${options.pass}` : '';
        const masked = options.user ? `username=${options.user},password=****` : '';
        const mountCmd = `${options.sudo ? 'sudo mount' : 'mount'} -t cifs -o `;
        const target = ` ${options.mount}${options.dir} ${options.backupDir}`;

        setTimeout(() => {
            log.debug(`cifs-mount command: "${mountCmd}${masked}${common},${options.smb}${target}"`);
            exec(`${mountCmd}${credentials}${common},${options.smb}${target}`, (error, stdout) => {
                if (error) {
                    log.debug(
                        'first mount attempt with smb option failed. try next mount attempt without smb option ...',
                    );
                    log.debug(`cifs-mount command: "${mountCmd}${masked}${common}${target}"`);
                    exec(`${mountCmd}${credentials}${common}${target}`, (retryError, retryStdout) => {
                        if (retryError) {
                            // `ExecException` is declared as Omit<ErrnoException, 'code'>, which drops
                            // the nominal Error identity; binding it back keeps the formatting equal.
                            const failure: Error = retryError;
                            let errLog = String(failure);
                            try {
                                const formatPass = options.pass.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                                errLog = errLog.replace(new RegExp(formatPass, 'g'), '****');
                            } catch {
                                // ignore
                            }
                            options.context.errors.mount = retryError;
                            log.error(`[${options.name} ${errLog}`);
                            callback?.(null, errLog);
                        } else {
                            log.debug('mount successfully completed');
                            options.context.done.push('mount');
                            writeMountMarker(options, log);
                            callback?.(null, retryStdout);
                        }
                    });
                } else {
                    log.debug('mount successfully completed');
                    options.context.done.push('mount');
                    // Unlike every other branch this write is not guarded by a try/catch.
                    writeFileSync(`${options.fileDir}/.mount`, options.mountType);
                    callback?.(null, stdout);
                }
            });
        }, waitTime);
    }

    if (options.mountType === 'NFS') {
        setTimeout(() => {
            log.debug(
                `nfs-mount command: "${options.sudo ? 'sudo mount' : 'mount'} ${options.mount}:${options.dir} ${options.backupDir}"`,
            );
            exec(
                `${options.sudo ? 'sudo mount' : 'mount'} ${options.mount}:${options.dir} ${options.backupDir}`,
                (error, stdout, stderr) => {
                    if (error) {
                        options.context.errors.mount = error;
                        log.error(`[${options.name} ${stderr}`);
                        // The Error travels in the stdout slot here, as before.
                        callback?.(null, error);
                    } else {
                        log.debug('mount successfully completed');
                        options.context.done.push('mount');
                        writeMountMarker(options, log);
                        callback?.(null, stdout);
                    }
                },
            );
        }, waitTime);
    }

    if (options.mountType === 'Expert') {
        setTimeout(() => {
            log.debug(`expert-mount command: "${options.expertMount}"`);
            exec(options.expertMount, (error, stdout, stderr) => {
                if (error) {
                    options.context.errors.mount = error;
                    log.error(`[${options.name} ${stderr}`);
                    callback?.(null, error);
                } else {
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

export const ignoreErrors = true;
