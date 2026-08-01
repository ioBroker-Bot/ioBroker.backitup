import { exec } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDirSync, removeSync } from 'fs-extra';

import { copyFile, getDate } from '../tools';
import { compress } from '../targz';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface RedisOptions {
    context: BackItUpExecuteContext;
    backupDir: string;
    redisType?: 'local' | 'remote';
    /** dump file or directory for a local backup */
    path: string;
    /** run `redis-cli save` before copying */
    aof?: boolean;
    host?: string;
    port?: number | string;
    user?: string;
    pass?: string;
    hostType?: 'Single' | 'Master' | 'Slave';
    slaveSuffix?: string;
    nameSuffix?: string;
}

/**
 * Mode for the temporary directory.
 *
 * As in 42-javascripts this is a string, and fs-extra's `getMode` spreads a non-number into its
 * defaults, so the value is discarded and the directory ends up with the default 0o777. Passing
 * `{ mode: 0o2775 }` would actually apply it. Left as found.
 */
const desiredMode = '0o2775';

export async function command(
    options: RedisOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    log.debug('Start Redis Backup ...');

    let cb = callback;

    let nameSuffix;
    if (options.hostType === 'Slave') {
        nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
    } else {
        nameSuffix = options.nameSuffix ? options.nameSuffix : '';
    }

    const fileName = join(
        options.backupDir,
        `${options.redisType === 'remote' ? 'redis-remote' : 'redis'}_${getDate()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`,
    );
    const tmpDir = join(options.backupDir, 'redistmp').replace(/\\/g, '/');

    // The cast only silences the type; the value handed over is unchanged (see desiredMode).
    const modeArg = desiredMode as unknown as number;

    if (!existsSync(tmpDir)) {
        try {
            ensureDirSync(tmpDir, modeArg);
            log.debug('Created redistmp directory');
        } catch {
            log.warn(`redis tmp directory "${tmpDir}" cannot created`);
        }
    } else {
        log.debug(`Try deleting the old redis tmp directory: "${tmpDir}"`);
        try {
            removeSync(tmpDir);
        } catch {
            log.warn(`old redis tmp directory "${tmpDir}" cannot deleted`);
        }
        if (!existsSync(tmpDir)) {
            log.debug(`old redis tmp directory "${tmpDir}" successfully deleted`);
            try {
                ensureDirSync(tmpDir, modeArg);
                log.debug('Created new redistmp directory');
            } catch {
                log.warn(`redis tmp directory "${tmpDir}" cannot created`);
            }
        }
    }

    options.context.fileNames.push(fileName);

    const timer = setInterval(() => {
        if (existsSync(fileName)) {
            const stats = statSync(fileName);
            const fileSize = Math.floor(stats.size / (1024 * 1024));
            log.debug(`Packed ${fileSize}MB so far...`);
        }
    }, 10000);

    /** Removes the temporary directory after a successful pack */
    const dropTmp = (): void => {
        try {
            log.debug(`Try deleting the redis tmp directory: "${tmpDir}"`);
            removeSync(tmpDir);
            if (!existsSync(tmpDir)) {
                log.debug(`redis tmp directory "${tmpDir}" successfully deleted`);
            }
        } catch (err) {
            log.warn(`redis tmp directory "${tmpDir}" cannot deleted ... ${err}`);
            cb?.(err as Error);
        }
    };

    if (options.redisType === 'local') {
        let name: string | undefined;
        let pth: string | undefined;
        let data: string[] = [];

        if (existsSync(options.path)) {
            const stat = statSync(options.path);
            if (!stat.isDirectory()) {
                const parts = options.path.replace(/\\/g, '/').split('/');
                name = parts.pop();
                pth = parts.join('/');
                data.push(name as string);
            } else {
                pth = options.path;
                try {
                    data = readdirSync(pth);
                } catch (err) {
                    cb?.(err as Error);
                }
            }
        }
        // save aof
        if (options.aof) {
            // Note: bgSave never settles when `redis-cli save` fails, so this await can hang.
            await bgSave(options, tmpDir, log, cb);
        }

        // Note: with several .rdb files this packs - and reports - once per file. And when no .rdb
        // file is found nothing runs at all and the callback never fires. Kept as found.
        data.forEach(file => {
            const currentFiletype = file.split('.').pop();

            if (currentFiletype === 'rdb' && !file.startsWith('temp')) {
                log.debug(`detected redis file: ${file} | file type: ${currentFiletype}`);
                try {
                    copyFile(join(pth as string, file), join(tmpDir, file), err => {
                        if (err) {
                            clearInterval(timer);
                            options.context.errors.redis = err.toString();
                            log.error(err as unknown as string);
                            cb?.(err);
                        } else {
                            compress(
                                {
                                    src: tmpDir,
                                    dest: fileName,
                                    tar: {
                                        ignore: nm => !!name && name !== nm.replace(/\\/g, '/').split('/').pop(),
                                    },
                                },
                                // lib/targz only ever passes an error; the stdout/stderr parameters
                                // the original declared here were always undefined.
                                packErr => {
                                    clearInterval(timer);
                                    if (packErr) {
                                        options.context.errors.redis = packErr.toString();
                                        cb?.(packErr);
                                    } else {
                                        log.debug(`Backup created: ${fileName}`);
                                        options.context.done.push('redis');
                                        options.context.types.push('redis');
                                        dropTmp();
                                        if (cb) {
                                            cb(null);
                                            cb = undefined;
                                        }
                                    }
                                },
                            );
                        }
                    });
                } catch (err) {
                    clearInterval(timer);
                    cb?.(err as Error);
                    cb = undefined;
                }
            }
        });
    } else if (options.redisType === 'remote') {
        try {
            exec(
                `redis-cli -u 'redis://${options.user && options.pass ? `${options.user}:${options.pass}@` : ''}${options.host}:${options.port}' --rdb ${join(tmpDir, 'dump.rdb').replace(/\\/g, '/')}`,
                error => {
                    if (error) {
                        clearInterval(timer);
                        // `ExecException` is declared as Omit<ErrnoException, 'code'>, which drops
                        // the nominal Error identity; binding it back keeps toString() identical.
                        const failure: Error = error;
                        options.context.errors.redis = failure.toString();
                        log.error(failure as unknown as string);
                        cb?.(error);
                    } else {
                        compress(
                            {
                                src: tmpDir,
                                dest: fileName,
                            },
                            packErr => {
                                clearInterval(timer);
                                if (packErr) {
                                    options.context.errors.redis = packErr.toString();
                                    cb?.(packErr);
                                } else {
                                    log.debug(`Backup created: ${fileName}`);
                                    options.context.done.push('redis');
                                    options.context.types.push('redis');
                                    dropTmp();
                                    if (cb) {
                                        cb(null);
                                        cb = undefined;
                                    }
                                }
                            },
                        );
                    }
                },
            );
        } catch (err) {
            clearInterval(timer);
            cb?.(err as Error);
            cb = undefined;
        }
    }
    // Note: any other redisType leaves the step without a callback.
}

/**
 * Asks redis to write its dump before the files are copied.
 *
 * On failure the promise is neither resolved nor rejected, so the caller's `await` never returns -
 * the error only reaches the callback. Kept as found.
 *
 * @param options script options, for the error store
 * @param tmpDir temporary directory that is removed on failure
 * @param log adapter logger
 * @param callback reports the failure
 */
function bgSave(
    options: RedisOptions,
    tmpDir: string,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<string> {
    return new Promise(resolve => {
        log.debug('redis-cli save started, please wait ...');

        let localCallback = callback;

        exec(`redis-cli save`, (error, stdout, stderr) => {
            if (error) {
                const failure: Error = error;
                options.context.errors.redis = failure.toString();
                try {
                    log.debug(`Try deleting the redis tmp directory: "${tmpDir}"`);
                    removeSync(tmpDir);
                    if (!existsSync(tmpDir)) {
                        log.debug(`redis tmp directory "${tmpDir}" successfully deleted`);
                    }
                } catch (err) {
                    log.warn(`redis tmp directory "${tmpDir}" cannot deleted ... ${err}`);
                    localCallback?.(err as Error);
                    localCallback = undefined;
                }
                localCallback?.(error);
                localCallback = undefined;
            } else {
                log.debug('redis-cli save finish');
                resolve(stdout ? stdout : stderr);
            }
        });
    });
}

export const ignoreErrors = true;
