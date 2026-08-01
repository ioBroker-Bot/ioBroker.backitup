import { existsSync, statSync } from 'node:fs';

import Onedrive from '../oneDriveLib';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface OneDriveUploadOptions {
    context: BackItUpExecuteContext;
    onedriveAccessJson: string;
    dir: string;
    deleteOldBackup?: boolean;
    advancedDelete?: boolean;
    deleteBackupAfter?: number;
    onedriveDeleteAfter?: number;
    influxDBMulti?: boolean;
    influxDBEvents?: unknown[];
    mySqlMulti?: boolean;
    mySqlEvents?: unknown[];
    pgSqlMulti?: boolean;
    pgSqlEvents?: unknown[];
    ccuMulti?: boolean;
    ccuEvents?: unknown[];
}

type Errors = BackItUpExecuteContext['errors'];
type Done = (error?: Error | string | null) => void;

async function copyFiles(
    od_accessToken: string,
    onedrive: Onedrive,
    dir: string,
    fileNames: string[],
    log: ioBroker.Logger,
    errors: Errors,
    callback?: Done,
): Promise<void> {
    if (!fileNames || !fileNames.length) {
        callback?.();
    } else {
        let fileName = fileNames.shift() as string;
        fileName = fileName.replace(/\\/g, '/');
        const onlyFileName = fileName.split('/').pop();

        if (existsSync(fileName)) {
            log.debug(`Onedrive: Copy ${onlyFileName}...`);

            await onedrive
                .fileUpload({
                    accessToken: od_accessToken,
                    parentPath: dir,
                    filePath: fileName,
                    log,
                    onProgress: bytes => {
                        log.debug(
                            `Progress: ${Math.round((bytes / statSync(fileName).size) * 100)}% uploaded from ${onlyFileName}`,
                        );
                    },
                })
                .then(item => {
                    log.debug(
                        `${item && item.name ? item.name : fileName} with Id: ${item && item.id ? item.id : 'undefined'} saved on Onedrive`,
                    );
                    setImmediate(copyFiles, od_accessToken, onedrive, dir, fileNames, log, errors, callback);
                })
                .catch(err => {
                    if (err) {
                        errors.onedrive = JSON.stringify(err);
                        log.error(`upload Onedrive: ${JSON.stringify(err)}`);
                    }
                    setImmediate(copyFiles, od_accessToken, onedrive, dir, fileNames, log, errors, callback);
                });
        } else {
            log.error(`Onedrive: File "${fileName}" not found`);
            setImmediate(copyFiles, od_accessToken, onedrive, dir, fileNames, log, errors, callback);
        }
    }
}

function deleteFiles(
    od_accessToken: string,
    onedrive: Onedrive,
    fileIds: string[],
    fileNames: string[],
    log: ioBroker.Logger,
    errors: Errors,
    callback?: Done,
): void {
    if (!fileIds?.length && !fileNames?.length) {
        callback?.();
    } else {
        const fileId = fileIds.shift() as string;
        const fileName = fileNames.shift();

        log.debug(`Onedrive: delete ${fileName} with Id: ${fileId}`);

        onedrive
            .deleteFileById({
                accessToken: od_accessToken,
                itemId: fileId,
            })
            .then(() => {
                setImmediate(deleteFiles, od_accessToken, onedrive, fileIds, fileNames, log, errors, callback);
            })
            .catch(error => {
                if (error) {
                    log.error(`Onedrive: ${JSON.stringify(error)}`);
                }
                setImmediate(deleteFiles, od_accessToken, onedrive, fileIds, fileNames, log, errors, callback);
            });
    }
}

async function cleanFiles(
    od_accessToken: string,
    options: OneDriveUploadOptions,
    dir: string,
    names: string[],
    num: number,
    log: ioBroker.Logger,
    errors: Errors,
    callback?: Done,
): Promise<void> {
    if (!num) {
        callback?.();
        return;
    }

    // A second client instance, as in the original.
    const onedrive = new Onedrive();

    try {
        const children = await onedrive.getFolderChildrenByPath({ accessToken: od_accessToken, dir });

        if (children) {
            const fileIds: string[] = [];
            const fileNames: string[] = [];

            names.forEach(name => {
                const subResult = children.filter(a => a.name.startsWith(name));
                let numDel = num;

                // Multi-instance setups produce one file per configured target per run.
                if (name === 'influxDB' && options.influxDBMulti) {
                    numDel = num * (options.influxDBEvents as unknown[]).length;
                }
                if (name === 'mysql' && options.mySqlMulti) {
                    numDel = num * (options.mySqlEvents as unknown[]).length;
                }
                if (name === 'pgsql' && options.pgSqlMulti) {
                    numDel = num * (options.pgSqlEvents as unknown[]).length;
                }
                if (name === 'homematic' && options.ccuMulti) {
                    numDel = num * (options.ccuEvents as unknown[]).length;
                }

                if (subResult.length > numDel) {
                    // delete oldest files
                    subResult.sort((a, b) => {
                        const at = new Date(a.lastModifiedDateTime as string).getTime();
                        const bt = new Date(b.lastModifiedDateTime as string).getTime();
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
            deleteFiles(od_accessToken, onedrive, fileIds, fileNames, log, errors, callback);
        } else {
            callback?.(null);
        }
    } catch (err) {
        log.error(`OneDrive cleanFiles error: ${(err as Error).message}`);
        callback?.(err as Error);
    }
}

export async function command(
    options: OneDriveUploadOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    // Token refresh
    const onedrive = new Onedrive();
    const od_accessToken = await onedrive.getToken(options.onedriveAccessJson, log).catch(err => {
        log.warn(`Onedrive Token: ${err} | Please refresh your Token!`);
        options.context.errors.onedrive = `Onedrive Token: ${err} | Please refresh your Token!`;
    });

    if (od_accessToken && options.context.fileNames.length) {
        const fileNames: string[] = JSON.parse(JSON.stringify(options.context.fileNames));

        let dir = (options.dir || '').replace(/\\/g, '/');

        if (!dir) {
            dir = 'root';
        }
        if (dir.startsWith('/')) {
            dir = dir.substring(1);
        }

        void copyFiles(od_accessToken, onedrive, dir, fileNames, log, options.context.errors, err => {
            if (err) {
                options.context.errors.onedrive = err;
                log.error(`Onedrive: ${err}`);
            }
            if (options.deleteOldBackup === true) {
                const onedriveDeleteAfter =
                    options.advancedDelete === false ? options.deleteBackupAfter : options.onedriveDeleteAfter;

                void cleanFiles(
                    od_accessToken,
                    options,
                    dir,
                    options.context.types,
                    onedriveDeleteAfter as number,
                    log,
                    options.context.errors,
                    cleanErr => {
                        if (cleanErr) {
                            options.context.errors.onedrive = options.context.errors.onedrive || cleanErr;
                        } else if (!options.context.errors.onedrive) {
                            options.context.done.push('onedrive');
                        }
                        callback?.(cleanErr);
                    },
                );
            } else {
                if (!options.context.errors.onedrive) {
                    options.context.done.push('onedrive');
                }
                callback?.(err);
            }
        });
    } else {
        callback?.();
    }
}

export const ignoreErrors = true;
