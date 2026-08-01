import { existsSync, readFileSync } from 'node:fs';
import { Agent } from 'node:https';
import { join } from 'node:path';
// webdav ships as ESM only; this module stays CommonJS, so the types have to be pulled in with an
// explicit resolution mode and the value import below has to remain a dynamic `import()`.
import type { FileStat, WebDAVClient } from 'webdav' with { 'resolution-mode': 'import' };

import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface WebDavUploadOptions {
    context: BackItUpExecuteContext;
    username?: string;
    pass?: string;
    url?: string;
    dir: string;
    signedCertificates?: boolean;
    deleteOldBackup?: boolean;
    advancedDelete?: boolean;
    deleteBackupAfter?: number;
    webdavDeleteAfter?: number;
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
    client: WebDAVClient,
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
        const onlyFileName = fileName.split('/').pop() as string;

        if (existsSync(fileName)) {
            try {
                const webdavFilename = join(dir, onlyFileName);

                log.debug(`WebDAV: Copy ${onlyFileName}...`);
                let fileContent: Buffer | null = readFileSync(fileName);

                // Upload File
                await client
                    .putFileContents(webdavFilename, fileContent, {
                        format: 'binary',
                        'Content-Type': 'application/octet-stream',
                        contentLength: fileContent.length,
                    } as never)
                    .then(() => {
                        fileContent = null;
                        setImmediate(copyFiles, client, dir, fileNames, log, errors, callback);
                    });
            } catch (e) {
                log.error(`WebDAV: ${e}`);
                setImmediate(copyFiles, client, dir, fileNames, log, errors, callback);
            }
        } else {
            log.error(`WebDAV: File "${fileName}" not found`);
            setImmediate(copyFiles, client, dir, fileNames, log, errors, callback);
        }
    }
}

function deleteFiles(
    client: WebDAVClient,
    files: string[],
    log: ioBroker.Logger,
    errors: Errors,
    callback?: Done,
): void {
    if (!files || !files.length) {
        callback?.();
    } else {
        log.debug(`WebDAV: delete ${files[0]}`);
        const file = files.shift() as string;

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

async function cleanFiles(
    client: WebDAVClient,
    options: WebDavUploadOptions,
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
    try {
        const result = await client.getDirectoryContents(dir.replace(/^\/$/, ''));

        if (result) {
            const files: string[] = [];
            names.forEach(name => {
                const subResult = result.filter(a => a.basename.startsWith(name));
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
        } else {
            callback?.();
        }
    } catch (e) {
        callback?.(e as Error);
    }
}

export async function command(
    options: WebDavUploadOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    if (options.username && options.pass && options.url && options.context.fileNames.length) {
        const fileNames: string[] = JSON.parse(JSON.stringify(options.context.fileNames));
        log.debug('Start WebDAV Upload ...');

        let dir = (options.dir || '').replace(/\\/g, '/');

        if (!dir || dir[0] !== '/') {
            dir = `/${dir || ''}`;
        }

        const { createClient } = await import('webdav');
        const agent = new Agent({ rejectUnauthorized: Boolean(options.signedCertificates) });

        let client: WebDAVClient | undefined;

        try {
            client = createClient(options.url, {
                username: options.username,
                password: options.pass,
                maxBodyLength: Infinity,
                httpsAgent: agent,
            });
        } catch (err) {
            options.context.errors.webdav = err as Error;
            log.error(`cannot connect to WebDAV: ${err}`);
            // No early return on purpose: the dereference below then throws into the next try, so
            // the callback reports twice. Preserved.
            callback?.();
        }
        try {
            if ((await client!.exists(dir)) === false) {
                await client!.createDirectory(dir);
            }
        } catch (e) {
            log.warn(`cannot created the backup directory: ${e}`);
            options.context.errors.webdav = e as Error;
            callback?.();
        }

        try {
            client!
                .getDirectoryContents(dir)
                .then(() => {
                    void copyFiles(client!, dir, fileNames, log, options.context.errors, err => {
                        if (err) {
                            options.context.errors.webdav = err;
                            log.error(`WebDAV: ${err}`);
                        }
                        if (options.deleteOldBackup === true) {
                            const webdavDeleteAfter =
                                options.advancedDelete === false
                                    ? options.deleteBackupAfter
                                    : options.webdavDeleteAfter;

                            void cleanFiles(
                                client!,
                                options,
                                dir,
                                options.context.types,
                                webdavDeleteAfter as number,
                                log,
                                options.context.errors,
                                cleanErr => {
                                    if (cleanErr) {
                                        options.context.errors.webdav =
                                            options.context.errors.webdav || cleanErr;
                                        callback?.(cleanErr);
                                    } else {
                                        if (!options.context.errors.webdav) {
                                            options.context.done.push('webdav');
                                        }
                                        callback?.();
                                    }
                                },
                            );
                        } else {
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
        } catch (e) {
            log.error(`Error WebDAV-Upload: ${e}`);
            options.context.errors.webdav = e as Error;
            callback?.(e as Error);
        }
    } else {
        callback?.();
    }
}

export const ignoreErrors = true;
