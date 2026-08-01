import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { getDate } from '../tools';
import { compress } from '../targz';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface EsphomeOptions {
    context: BackItUpExecuteContext;
    /** directory holding the `esphome.<n>` data folders */
    path: string;
    backupDir: string;
    hostType?: 'Single' | 'Master' | 'Slave';
    slaveSuffix?: string;
    nameSuffix?: string;
}

export async function command(
    options: EsphomeOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    const esphomeInst: string[] = [];
    let dirs: string[] = [];

    // find all esphome dirs
    if (existsSync(options.path)) {
        dirs = readdirSync(options.path).filter(name => {
            const fullPath = join(options.path, name);
            return statSync(fullPath).isDirectory() && name.startsWith('esphome.');
        });
    }

    if (dirs.length) {
        log.debug(`found esphome data: ${dirs.join(',')}`);
    } else {
        log.warn('no esphome data found!!');
        callback?.(null, 'done');
        return;
    }

    // Cleared after the first failure so the error is only reported once, while the loop keeps
    // going over the remaining instances.
    let cb = callback;

    for (const dirName of dirs) {
        const pth = join(options.path, dirName);

        const nameSuffix = options.hostType === 'Slave' ? options.slaveSuffix || '' : options.nameSuffix || '';

        const fileName = join(
            options.backupDir,
            `${dirName}_${getDate()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`,
        );

        // compress dir
        try {
            await compressAsync(pth, fileName);
            log.debug(`Backup created: ${fileName}`);

            options.context.fileNames.push(fileName);
            options.context.types.push(dirName);
            options.context.done.push(dirName);
            esphomeInst.push(dirName);
        } catch (err) {
            options.context.errors.esphome = (err as Error).toString();
            log.error(err);

            if (cb) {
                cb(err as Error, (err as Error).toString());
                cb = undefined;
            }
        }
    }

    cb?.(null, 'done');
}

/**
 * compression as Promise
 *
 * @param pth directory to pack
 * @param fileName archive to write
 */
function compressAsync(pth: string, fileName: string): Promise<void> {
    return new Promise((resolve, reject) => {
        compress(
            {
                src: pth,
                dest: fileName,
                tar: {
                    ignore: name => basename(name) === '.esphome' || basename(name) === '.gitignore',
                },
            },
            err => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            },
        );
    });
}

export const ignoreErrors = true;
