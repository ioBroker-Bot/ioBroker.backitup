import { exec } from 'node:child_process';
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getIobDir } from '../tools';
import type { BackItUpConfigStorageCifs, BackItUpStorage } from '../types';
import type {
    BackItUpGetFileCallback,
    BackItUpListCallback,
    BackItUpStorageEngineResult,
    BackItUpStorageEngineResultFile,
} from './types';

const backupDir = join(getIobDir(), 'backups').replace(/\\/g, '/');

/** `mount`/`umount` report the shell output of the successful attempt */
type MountCallback = (error?: Error | string | null, stdout?: string) => void;

type CifsOptions = BackItUpConfigStorageCifs;

export function list(
    restoreSource: BackItUpStorage | '' | undefined,
    options: CifsOptions,
    types: string[],
    log: ioBroker.Logger,
    callback?: BackItUpListCallback,
): void {
    if (options.enabled && (!restoreSource || restoreSource === 'cifs')) {
        if (options.mountType === 'CIFS' || options.mountType === 'NFS' || options.mountType === 'Expert') {
            mount(options, log, error => {
                if (error) {
                    log.error(String(error));
                }
                nasList(restoreSource, options, types, log, callback);
            });
        } else {
            nasList(restoreSource, options, types, log, callback);
        }
    } else {
        setImmediate(() => callback?.());
    }
}

function nasList(
    restoreSource: BackItUpStorage | '' | undefined,
    options: CifsOptions,
    types: string[],
    log: ioBroker.Logger,
    callback?: BackItUpListCallback,
): void {
    if (options.enabled && (!restoreSource || restoreSource === 'cifs')) {
        let dir = backupDir.replace(/\\/g, '/');

        if (options.mountType === 'Copy') {
            if (options.ownDir === true) {
                dir = options.dirMinimal.replace(/\\/g, '/');
            } else if (options.ownDir === false) {
                dir = (options.dir as string).replace(/\\/g, '/');
            }
        }

        if (dir[0] !== '/' && !dir.match(/\w:/)) {
            dir = `/${dir || ''}`;
        }

        const files: BackItUpStorageEngineResult = {};
        if (existsSync(dir)) {
            try {
                const paths = readdirSync(dir)
                    .sort()
                    .map(file => join(dir, file).replace(/\\/g, '/'));

                if (paths && paths.length) {
                    const result: BackItUpStorageEngineResultFile[] = paths
                        .map(file => {
                            const stat = statSync(file);
                            return { path: file, name: file.split('/').pop() as string, size: stat.size };
                        })
                        .filter(
                            file =>
                                (types.indexOf(file.name.split('_')[0]) !== -1 ||
                                    types.indexOf(file.name.split('.')[0]) !== -1) &&
                                file.name.split('.').pop() == 'gz',
                        );

                    result.forEach(file => {
                        const type = file.name.split('_')[0];
                        files[type] = files[type] || [];
                        files[type].push(file);
                    });
                }
            } catch (e) {
                log.warn(`Source cannot be reached: ${e}`);
            }
        }
        // Not 'cifs': the restore tab and lib/restore both address a NAS source by this key.
        callback?.(null, files, 'nas / copy');
    } else {
        setImmediate(() => callback?.());
    }
}

function copyFileCifs(
    options: CifsOptions,
    fileName: string,
    toStoreName: string,
    log: ioBroker.Logger,
    callback?: BackItUpGetFileCallback,
): void {
    try {
        log.debug(`Get file ${fileName}`);
        log.debug(`Mount type: ${options.mountType != undefined ? options.mountType : 'Copy'}`);

        if (options.mountType === 'CIFS' || options.mountType === 'NFS' || options.mountType === 'Expert') {
            callback?.(null);
        } else {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fse = require('fs-extra');

            fse.copy(fileName, toStoreName, (err: Error) => {
                if (err) {
                    log.error(String(err));
                }
                callback?.(null);
            });
        }
    } catch (e) {
        log.error(String(e));

        if (options.mountType === 'CIFS' || options.mountType === 'NFS' || options.mountType === 'Expert') {
            umount(options, log, error => callback?.(error));
        } else {
            callback?.(e as Error);
        }
    }
}

export function getFile(
    options: CifsOptions,
    fileName: string,
    toStoreName: string,
    log: ioBroker.Logger,
    callback?: BackItUpGetFileCallback,
): void {
    if (options && options.enabled) {
        if (options.mountType === 'CIFS' || options.mountType === 'NFS' || options.mountType === 'Expert') {
            // Nothing to fetch - the share is mounted onto the backup directory itself.
            callback?.(null);
        } else {
            copyFileCifs(options, fileName, toStoreName, log, callback);
        }
    } else {
        setImmediate(() => callback?.('Not configured'));
    }
}

/**
 * Removes the marker file that records an active mount
 *
 * @param options resolved storage settings
 * @param log adapter logger
 * @param markerPath file to unlink
 */
function dropMountMarker(options: CifsOptions, log: ioBroker.Logger, markerPath: string): void {
    try {
        if (existsSync(`${options.fileDir}/.mount`)) {
            unlinkSync(markerPath);
        }
    } catch (e) {
        log.debug(`file ".mount" cannot deleted: ${e}`);
    }
}

/**
 * Writes the marker file that records an active mount
 *
 * @param options resolved storage settings
 * @param log adapter logger
 */
function writeMountMarker(options: CifsOptions, log: ioBroker.Logger): void {
    try {
        writeFileSync(`${options.fileDir}/.mount`, options.mountType);
    } catch (e) {
        log.debug(`file ".mount" cannot created: ${e}`);
    }
}

function mount(options: CifsOptions, log: ioBroker.Logger, callback?: MountCallback): void {
    let dir = options.dir as string;

    if (options.ownDir === true) {
        dir = options.dirMinimal;
    }

    if (existsSync(`${options.fileDir}/.mount`)) {
        exec(`mount | grep -o "${backupDir}"`, (_error, stdout) => {
            if (stdout.includes(backupDir)) {
                exec(`${options.sudo ? 'sudo umount' : 'umount'} ${backupDir}`, error => {
                    if (error) {
                        log.debug('device is busy... wait 2 Minutes!!');
                        setTimeout(() => {
                            exec(
                                `${options.sudo ? 'sudo umount' : 'umount'} -l ${backupDir}`,
                                (lazyError, _lazyStdout, lazyStderr) => {
                                    if (lazyError) {
                                        log.error(lazyStderr);
                                    } else {
                                        // Note the missing slash: this deletes `<fileDir>.mount`,
                                        // not `<fileDir>/.mount`, so the marker survives here.
                                        // Preserved - the marker drives the mount bookkeeping.
                                        dropMountMarker(options, log, `${options.fileDir}.mount`);
                                    }
                                },
                            );
                        }, 120000);
                    } else {
                        dropMountMarker(options, log, `${options.fileDir}/.mount`);
                    }
                });
            }
        });
    }

    if (options.mountType === 'CIFS') {
        if (!options.mount.startsWith('//')) {
            options.mount = `//${options.mount}`;
        }

        if (!dir.startsWith('/')) {
            dir = `/${dir}`;
        }

        if (
            (!options.pass.startsWith(`"`) || !options.pass.endsWith(`"`)) &&
            (!options.pass.startsWith(`'`) || !options.pass.endsWith(`'`))
        ) {
            options.pass = `"${options.pass}"`;
        }

        const common =
            `${options.cifsDomain ? `,domain=${options.cifsDomain}` : ''}` +
            `${options.clientInodes ? ',noserverino' : ''}` +
            `${options.cacheLoose ? ',cache=loose' : ''}` +
            `,rw,forceuid,uid=iobroker,forcegid,gid=iobroker,file_mode=0777,dir_mode=0777`;
        const credentials = options.user ? `username=${options.user},password=${options.pass}` : '';
        const masked = options.user ? `username=${options.user},password=****` : '';
        const mountCmd = `${options.sudo ? 'sudo mount' : 'mount'} -t cifs -o `;
        const target = ` ${options.mount}${dir} ${backupDir}`;

        log.debug(`cifs-mount command: "${mountCmd}${masked}${common},${options.smb}${target}"`);
        exec(`${mountCmd}${credentials}${common},${options.smb}${target}`, (error, stdout) => {
            if (error) {
                log.debug('first mount attempt with smb option failed. try next mount attempt without smb option ...');
                log.debug(`cifs-mount command: "${mountCmd}${masked}${common}${target}"`);
                exec(`${mountCmd}${credentials}${common}${target}`, (retryError, retryStdout) => {
                    if (retryError) {
                        // `ExecException` is declared as Omit<ErrnoException, 'code'>, which drops the
                        // nominal Error identity. The value really is an Error, so binding it as one
                        // keeps the formatted output identical to the previous `${error}`.
                        const failure: Error = retryError;
                        let errLog = String(failure);
                        try {
                            const formatPass = options.pass.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                            errLog = errLog.replace(new RegExp(formatPass, 'g'), '****');
                        } catch {
                            // ignore
                        }
                        callback?.(errLog);
                    } else {
                        log.debug('mount successfully completed');
                        writeMountMarker(options, log);
                        callback?.(null, retryStdout);
                    }
                });
            } else {
                log.debug('mount successfully completed');
                writeMountMarker(options, log);
                callback?.(null, stdout);
            }
        });
    } else if (options.mountType === 'NFS') {
        if (!dir.startsWith('/')) {
            dir = `/${dir}`;
        }
        log.debug(`nfs-mount command: "${options.sudo ? 'sudo mount' : 'mount'} ${options.mount}:${dir} ${backupDir}"`);
        exec(`${options.sudo ? 'sudo mount' : 'mount'} ${options.mount}:${dir} ${backupDir}`, (error, stdout) => {
            if (error) {
                callback?.(error);
            } else {
                log.debug('mount successfully completed');
                writeMountMarker(options, log);
                callback?.(null, stdout);
            }
        });
    } else if (options.mountType === 'Expert') {
        log.debug(`expert-mount command: "${options.expertMount}"`);
        exec(options.expertMount, (error, stdout) => {
            if (error) {
                callback?.(error);
            } else {
                log.debug('expert-mount successfully completed');
                writeMountMarker(options, log);
                callback?.(null, stdout);
            }
        });
    }
    // Note: for any other mount type nothing runs and the callback is never invoked.
}

function umount(options: CifsOptions, log: ioBroker.Logger, callback?: MountCallback): void {
    if (!options.mount) {
        callback?.('NO mount path specified!');
        return;
    }
    // Note: when the marker file is absent the callback is never invoked either.
    if (existsSync(`${options.fileDir}/.mount`)) {
        exec(`mount | grep -o "${backupDir}"`, (_error, stdout) => {
            if (stdout.includes(backupDir)) {
                exec(`${options.sudo ? 'sudo umount' : 'umount'} ${backupDir}`, (error, umountStdout) => {
                    if (error) {
                        log.debug('device is busy... wait 2 Minutes!!');
                        setTimeout(() => {
                            exec(
                                `${options.sudo ? 'sudo umount' : 'umount'} -l ${backupDir}`,
                                (lazyError, lazyStdout, lazyStderr) => {
                                    if (lazyError) {
                                        log.error(lazyStderr);
                                        callback?.(lazyError);
                                    } else {
                                        log.debug('umount successfully completed');
                                        dropMountMarker(options, log, `${options.fileDir}/.mount`);
                                        callback?.(null, lazyStdout);
                                    }
                                },
                            );
                        }, 120000);
                    } else {
                        log.debug('umount successfully completed');
                        dropMountMarker(options, log, `${options.fileDir}/.mount`);
                        callback?.(null, umountStdout);
                    }
                });
            } else {
                log.debug('mount inactive, umount not started ...');
                dropMountMarker(options, log, `${options.fileDir}/.mount`);
                callback?.(null);
            }
        });
    }
}
