import { fork } from 'node:child_process';
import { tools } from '@iobroker/js-controller-common';

import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

export function restore(
    _options: BackItUpRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    callback?: BackItUpRestoreCallback,
): void {
    let cb = callback;
    const ioPath = `${tools.getControllerDir()}/iobroker.js`;

    try {
        log.debug(`Start ioBroker Restore from "${fileName}"...`);
        log.debug(ioPath);
        const cmd = fork(ioPath, ['restore', fileName, '--force'], { silent: true });
        cmd.stdout!.on('data', data => log.debug(data.toString()));

        cmd.stderr!.on('data', data => log.error(data.toString()));

        cmd.on('close', code => {
            if (cb) {
                // Logged as a success regardless of the exit code; the code itself is passed on.
                log.debug('ioBroker Restore completed successfully');
                cb(null, code);
                cb = undefined;
            }
        });

        cmd.on('error', error => {
            log.error(error);
            if (cb) {
                cb(error, -1);
                cb = undefined;
            }
        });
    } catch (error) {
        log.error('ioBroker Restore not completed');
        log.error(error);

        if (cb) {
            cb(error, -1);
            cb = undefined;
        }
    }
}

export const isStop = true;
