import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { copy, ensureDir, remove } from 'fs-extra';

import { getDate } from '../tools';
import { compress } from '../targz';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface NoderedOptions {
    context: BackItUpExecuteContext;
    /** directory holding the `node-red` / `node-red.<n>` data folders */
    path: string;
    backupDir: string;
    hostType?: 'Single' | 'Master' | 'Slave';
    slaveSuffix?: string;
    nameSuffix?: string;
}

export async function command(
    options: NoderedOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    const noderedInst: string[] = [];

    try {
        // Note: the loop runs to 100 but only index 10 reports back, and only when no matching
        // directory exists there. With a `node-red.10` present nothing calls the callback at all.
        // Kept as found.
        for (let i = 0; i <= 100; i++) {
            const nrDir = i === 0 ? 'node-red' : `node-red.${i}`;
            const pth = join(options.path, nrDir).replace(/\\/g, '/');

            if (existsSync(pth)) {
                noderedInst.push(`node-red.${i}`);

                const nameSuffix =
                    options.hostType === 'Slave' && options.slaveSuffix
                        ? options.slaveSuffix
                        : options.hostType !== 'Slave' && options.nameSuffix
                          ? options.nameSuffix
                          : '';
                const fileName = join(
                    options.backupDir,
                    `nodered.${i}_${getDate()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`,
                );
                const tmpDir = join(options.backupDir, `noderedtmp${i}`).replace(/\\/g, '/');

                const desiredMode = {
                    mode: 0o2775,
                };

                if (!existsSync(tmpDir)) {
                    log.debug('Created nodered tmp directory');
                    try {
                        await ensureDir(tmpDir, desiredMode);
                    } catch {
                        log.error(`Node-Red tmp directory "${tmpDir}" cannot created`);
                    }
                } else {
                    try {
                        await delTmp(options, tmpDir, log);
                    } catch {
                        log.error(
                            `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
                        );
                    }

                    if (!existsSync(tmpDir)) {
                        log.debug('Created new nodered tmp directory');
                        try {
                            await ensureDir(tmpDir, desiredMode);
                        } catch {
                            log.error(`Node-Red tmp directory "${tmpDir}" cannot created`);
                        }
                    }
                }

                await tmpCopy(pth, tmpDir, log);
                await compressBackupFile(fileName, tmpDir, log, options, callback);

                try {
                    await delTmp(options, tmpDir, log);
                } catch {
                    log.error(
                        `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
                    );
                }

                options.context.fileNames.push(fileName);
                options.context.types.push(`nodered.${i}`);
                options.context.done.push(`nodered.${i}`);

                if (i === 10) {
                    if (noderedInst.length) {
                        log.debug(`found node-red database: ${noderedInst.join(',')}`);
                    } else {
                        log.warn('no Node-Red database found!!');
                    }
                }
            } else if (!existsSync(pth) && i === 10) {
                if (noderedInst.length) {
                    log.debug(`found node-red database: ${noderedInst.join(',')}`);
                } else {
                    log.warn('no node-red database found!!');
                }
                callback?.(null, 'done');
            }
        }
    } catch (err) {
        options.context.errors.nodered = JSON.stringify(err);
        log.error(`Error on node-red Backup: ${err}`);
        callback?.(null, err as Error);
    }
}

/**
 * Removes a temporary directory, rejecting when it cannot be deleted.
 *
 * @param options script options, for the error store
 * @param tmpDir directory to remove
 * @param log adapter logger
 */
async function delTmp(options: NoderedOptions, tmpDir: string, log: ioBroker.Logger): Promise<void> {
    log.debug(`Try deleting the old node-red tmp directory: "${tmpDir}"`);

    return remove(tmpDir)
        .then(() => {
            if (!existsSync(tmpDir)) {
                log.debug(`node-red tmp directory "${tmpDir}" successfully deleted`);
            }
        })
        .catch(err => {
            options.context.errors.nodered = JSON.stringify(err);
            log.error(
                `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
            );
            throw err;
        });
}

/**
 * Copies the Node-RED data aside, leaving node_modules out.
 *
 * @param pth source directory
 * @param tmpDir destination directory
 * @param log adapter logger
 */
async function tmpCopy(pth: string, tmpDir: string, log: ioBroker.Logger): Promise<void> {
    return copy(pth, tmpDir, { filter: entry => !entry.includes('node_modules') }).then(() => {
        log.debug('Node-Red tmp copy finish');
    });
}

/**
 * Packs the prepared copy.
 *
 * The callback parameter is deliberately local: the original cleared it here, which never reached
 * the caller's variable, so `command` can still report afterwards. On failure the promise rejects
 * without a reason - and when no callback was handed in it neither resolves nor rejects, stalling
 * the loop. Both preserved.
 *
 * @param fileName archive to write
 * @param tmpDir prepared copy to pack
 * @param log adapter logger
 * @param options script options, for the error store
 * @param callback reports a packing failure
 */
async function compressBackupFile(
    fileName: string,
    tmpDir: string,
    log: ioBroker.Logger,
    options: NoderedOptions,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    return new Promise((resolve, reject) => {
        let localCallback = callback;

        compress(
            {
                src: tmpDir,
                dest: fileName,
            },
            // lib/targz only ever passes an error; the second parameter the original declared here
            // was always undefined.
            err => {
                if (err) {
                    options.context.errors.nodered = err.toString();
                    if (localCallback) {
                        localCallback(err);
                        localCallback = undefined;
                        reject(undefined);
                    }
                } else {
                    log.debug(`Backup created: ${fileName}`);
                    resolve();
                }
            },
        );
    });
}

export const ignoreErrors = true;
