import { exec } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDirSync, removeSync } from 'fs-extra';

import { copyFile } from '../tools';
import { decompress } from '../targz';
import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

interface RedisRestoreOptions extends BackItUpRestoreOptions {
    /** the redis dump file or its directory */
    path: string;
    /** rewrite the append-only file after the restore */
    aof?: boolean;
}

/** Module level, so a second restore overwrites the handle of the first. Kept as found. */
let waitRestore: NodeJS.Timeout | undefined;

export function restore(
    options: RedisRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    callback?: BackItUpRestoreCallback,
): void {
    let cb = callback;

    log.debug('Start Redis Restore ...');

    // A string, so fs-extra reads no mode from it and falls back to the default. Kept as found.
    const desiredMode = '0o2775';

    const tmpDir = join(options.backupDir, 'redistmp').replace(/\\/g, '/');
    if (!existsSync(tmpDir)) {
        ensureDirSync(tmpDir, desiredMode as unknown as number);
        log.debug('Created redistmp directory');
    } else {
        log.debug(`Try deleting the old redis tmp directory: "${tmpDir}"`);
        removeSync(tmpDir);
        if (!existsSync(tmpDir)) {
            log.debug(`old redis tmp directory "${tmpDir}" successfully deleted`);
            ensureDirSync(tmpDir, desiredMode as unknown as number);
            log.debug('Created redistmp directory');
        }
    }

    const timer = setInterval(() => {
        if (existsSync(options.path)) {
            log.debug('Extracting Redis Backup file...');
        } else {
            log.debug('Something is wrong. No file found.');
        }
    }, 10000);

    let name;
    // NOTE: `pth` stays undefined when `options.path` exists as a directory is false *and* the
    // file name starts with a dot - `indexOf('.')` is checked for truthiness, so only position 0
    // counts as "no dot". `join(undefined, file)` then throws below. Kept as found.
    let pth: string | undefined;
    if (!existsSync(options.path)) {
        const parts = options.path.replace(/\\/g, '/').split('/');
        name = parts.pop()!;
        if (name.indexOf('.')) {
            pth = parts.join('/');
        }
    } else {
        pth = options.path;
    }

    try {
        log.debug('decompress started ...');

        waitRestore = setTimeout(
            () =>
                decompress(
                    {
                        src: fileName,
                        dest: tmpDir,
                    },
                    // lib/targz only ever passes an error, so the `stderr` the original forwarded
                    // as the exit code was always undefined.
                    err => {
                        if (err) {
                            clearInterval(timer);
                            log.error('Redis Restore not completed');
                            log.error(err);
                            if (cb) {
                                cb(err);
                                cb = undefined;
                            }
                        } else {
                            clearInterval(timer);
                            if (cb) {
                                let files: string[] = [];
                                if (existsSync(tmpDir)) {
                                    files = readdirSync(tmpDir);
                                    let num = 0;
                                    files.forEach(file => {
                                        try {
                                            copyFile(join(tmpDir, file), join(pth!, file), err => {
                                                if (err) {
                                                    log.error(err);
                                                    cb?.(null, 'redis restore broken');
                                                    cb = undefined;
                                                } else {
                                                    num++;
                                                    if (existsSync(join(`${pth}/${file}`))) {
                                                        log.debug(`redis file ${file} successfully restored`);
                                                    }

                                                    log.debug('redis-cli restart, please wait ...');

                                                    if (files.length === num) {
                                                        if (options.aof === true) {
                                                            log.debug(
                                                                'redis-cli bgrewriteaof started, please wait ...',
                                                            );
                                                            try {
                                                                exec(`redis-cli bgrewriteaof`, error => {
                                                                    if (error) {
                                                                        log.debug(
                                                                            `redis-cli bgrewriteaof error: "${error}"`,
                                                                        );
                                                                    }
                                                                });
                                                            } catch (e) {
                                                                log.debug(`redis-cli bgrewriteaof error: "${e}"`);
                                                            }
                                                        }
                                                        try {
                                                            log.debug(
                                                                `Try deleting the redis tmp directory: "${tmpDir}"`,
                                                            );
                                                            removeSync(tmpDir);
                                                            if (!existsSync(tmpDir)) {
                                                                log.debug(
                                                                    `redis tmp directory "${tmpDir}" successfully deleted`,
                                                                );
                                                            }
                                                        } catch (err) {
                                                            // Reports and clears the callback, but
                                                            // does not return - the success report
                                                            // below is therefore skipped.
                                                            log.debug(
                                                                `redis tmp directory "${tmpDir}" cannot deleted ... ${err}`,
                                                            );
                                                            cb?.(null, 'redis restore is incomplete');
                                                            cb = undefined;
                                                        }
                                                        clearTimeout(waitRestore);
                                                        log.debug('Redis Restore completed successfully');
                                                        cb?.(null, 'redis restore done');
                                                        cb = undefined;
                                                    }
                                                }
                                            });
                                        } catch (err) {
                                            log.error(`Redis Restore not completed: ${err}`);
                                            cb?.(null, 'redis restore is incomplete');
                                            cb = undefined;
                                        }
                                    });
                                }
                            }
                        }
                    },
                ),
            2000,
        );
    } catch (e) {
        if (cb) {
            clearInterval(timer);
            cb(e);
            cb = undefined;
        }
    }
}

export const isStop = true;
