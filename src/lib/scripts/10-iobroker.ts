import { fork } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getDate, getSize } from '../tools';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface IobrokerOptions {
    context: BackItUpExecuteContext;
    /** path to the iobroker CLI that performs the backup */
    workDir?: string;
    backupDir: string;
    nameSuffix?: string;
}

/** Warn above this archive size, in megabytes */
const SIZE_WARNING_MB = 500;

export function command(options: IobrokerOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    let cb = callback;

    if (options.workDir != undefined) {
        const ioPath = options.workDir;

        try {
            const fileName = join(
                options.backupDir,
                `iobroker_${getDate()}${options.nameSuffix ? `_${options.nameSuffix}` : ''}_backupiobroker.tar.gz`,
            );

            options.context.fileNames.push(fileName);

            const cmd = fork(ioPath, ['backup', fileName], { silent: true });
            cmd.stdout!.on('data', data => log.debug(data.toString()));

            cmd.stderr!.on('data', data => log.error(data.toString()));

            cmd.on('close', code => {
                // Recorded as done regardless of the exit code; a missing file is what marks the
                // failure below. Kept as found.
                options.context.done.push('iobroker');
                options.context.types.push('iobroker');

                if (existsSync(fileName)) {
                    const stat = statSync(fileName);

                    if (Math.round((stat.size / (1024 * 1024)) * 10) / 10 > SIZE_WARNING_MB) {
                        log.warn(
                            `Your backup ${fileName.split('/').pop()} has a file size of ${getSize(stat.size)}. This can lead to problems. Please check your file system for large files.`,
                        );
                    }
                } else {
                    options.context.errors.iobroker = 'ioBroker Backup not created';
                }
                if (cb) {
                    cb(null, null, code);
                    cb = undefined;
                }
            });

            cmd.on('error', error => {
                options.context.errors.iobroker = error;
                console.error(`error: ${error}`);
                if (cb) {
                    cb(error, null, -1);
                    cb = undefined;
                }
            });
        } catch (error) {
            options.context.errors.iobroker = error as Error;
            if (cb) {
                cb(error as Error, null, -1);
                cb = undefined;
            }
        }
    } else {
        options.context.errors.iobroker = 'Unable to read iobroker path';
        log.error('Unable to read iobroker path');
        if (cb) {
            cb(null, null, -1);
            cb = undefined;
        }
    }
}

export const ignoreErrors = false;
