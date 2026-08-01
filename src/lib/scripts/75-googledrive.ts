import { createReadStream, existsSync } from 'node:fs';

import GoogleDrive from '../googleDriveLib';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface GoogleDriveUploadOptions {
    context: BackItUpExecuteContext;
    accessJson?: string;
    newToken?: boolean | string;
    dir: string;
    deleteOldBackup?: boolean;
    advancedDelete?: boolean;
    deleteBackupAfter?: number;
    googledriveDeleteAfter?: number;
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

function copyFiles(
    gDrive: GoogleDrive,
    dir: string,
    fileNames: string[],
    log: ioBroker.Logger,
    errors: Errors,
    callback?: Done,
): void {
    if (!fileNames || !fileNames.length) {
        callback?.();
    } else {
        let fileName = fileNames.shift() as string;
        fileName = fileName.replace(/\\/g, '/');
        const onlyFileName = fileName.split('/').pop() as string;

        if (existsSync(fileName)) {
            gDrive
                .createFolder(dir, log)
                .then(folderId => {
                    const readStream = createReadStream(fileName);
                    readStream.on('error', err => {
                        if (err) {
                            log.error(`Google Drive: ${err}`);
                        }
                    });

                    log.debug(`Google Drive: Copy ${onlyFileName}...`);

                    // Note: on a write failure this schedules the next file here, and the `.then`
                    // below schedules it again - the walk then advances twice. Kept as found.
                    return gDrive.writeFile(folderId as string, onlyFileName, readStream, log).catch(err => {
                        log.error(`Google Drive writeFile failed: ${err}`);
                        setTimeout(copyFiles, 150, gDrive, dir, fileNames, log, errors, callback);
                    });
                })
                .then(() => setTimeout(copyFiles, 150, gDrive, dir, fileNames, log, errors, callback))
                .catch(err => {
                    log.error(`Google Drive writeFile Error: ${err}`);
                    setTimeout(copyFiles, 150, gDrive, dir, fileNames, log, errors, callback);
                });
        } else {
            log.error(`Google Drive: File "${fileName}" not found`);
            setTimeout(copyFiles, 150, gDrive, dir, fileNames, log, errors, callback);
        }
    }
}

function deleteFiles(
    gDrive: GoogleDrive,
    fileIds: string[],
    fileNames: string[],
    log: ioBroker.Logger,
    errors: Errors,
    callback?: Done,
): void {
    if ((!fileIds || !fileIds.length) && (!fileNames || !fileNames.length)) {
        callback?.();
    } else {
        const fileId = fileIds.shift() as string;
        const fileName = fileNames.shift();
        log.debug(`Google Drive: delete ${fileName}`);

        gDrive
            .deleteFile(fileId)
            .then(() => setTimeout(deleteFiles, 150, gDrive, fileIds, fileNames, log, errors, callback))
            .catch(err => {
                if (err) {
                    log.error(`Google Drive: ${err}`);
                }
                setTimeout(deleteFiles, 150, gDrive, fileIds, fileNames, log, errors, callback);
            });
    }
}

function cleanFiles(
    gDrive: GoogleDrive,
    options: GoogleDriveUploadOptions,
    dir: string,
    names: string[],
    num: number,
    log: ioBroker.Logger,
    errors: Errors,
    callback?: Done,
): void {
    if (!num) {
        callback?.();
        return;
    }
    gDrive
        .getFileOrFolderId(dir)
        .then(folderId => gDrive.listFilesInFolder(folderId as string))
        .then(result => {
            if (result && result.length) {
                const fileIds: string[] = [];
                const fileNames: string[] = [];
                names.forEach(name => {
                    const subResult = result.filter(a => (a.name as string).startsWith(name));
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

                    // sort files
                    if (subResult.length > numDel) {
                        // delete oldest files
                        subResult.sort((a, b) => {
                            const at = new Date(a.modifiedTime as string).getTime();
                            const bt = new Date(b.modifiedTime as string).getTime();
                            if (at > bt) {
                                return -1;
                            }
                            if (at < bt) {
                                return 1;
                            }
                            return 0;
                        });

                        for (let i = numDel; i < subResult.length; i++) {
                            fileIds.push(subResult[i].id as string);
                            fileNames.push(subResult[i].name as string);
                        }
                    }
                });
                deleteFiles(gDrive, fileIds, fileNames, log, errors, callback);
            } else {
                callback?.();
            }
        })
        .catch(err => {
            log.error(`Google Drive: ${err}`);
            callback?.(err);
        });
}

export function command(
    options: GoogleDriveUploadOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): void {
    if (options.accessJson && options.context.fileNames.length) {
        const fileNames: string[] = JSON.parse(JSON.stringify(options.context.fileNames));
        const gDrive = new GoogleDrive(options.accessJson, options.newToken);

        if (!gDrive) {
            callback?.('No or invalid access key');
            return;
        }

        let dir = (options.dir || '').replace(/\\/g, '/');

        if (!dir || dir[0] !== '/') {
            dir = `/${dir || ''}`;
        }

        copyFiles(gDrive, dir, fileNames, log, options.context.errors, err => {
            if (err) {
                options.context.errors.googledrive = err;
                log.error(`Google Drive: ${err}`);
            }
            if (options.deleteOldBackup === true) {
                const googledriveDeleteAfter =
                    options.advancedDelete === false ? options.deleteBackupAfter : options.googledriveDeleteAfter;

                cleanFiles(
                    gDrive,
                    options,
                    dir,
                    options.context.types,
                    googledriveDeleteAfter as number,
                    log,
                    options.context.errors,
                    cleanErr => {
                        if (cleanErr) {
                            options.context.errors.googledrive = options.context.errors.googledrive || cleanErr;
                        } else if (!options.context.errors.googledrive) {
                            options.context.done.push('googledrive');
                        }
                        callback?.(cleanErr);
                    },
                );
            } else {
                if (!options.context.errors.googledrive) {
                    options.context.done.push('googledrive');
                }
                callback?.(err);
            }
        });
    } else {
        callback?.();
    }
}

export const ignoreErrors = true;
