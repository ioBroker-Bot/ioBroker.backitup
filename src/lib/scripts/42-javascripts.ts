import { existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ensureDirSync, removeSync } from 'fs-extra';

import { getDate } from '../tools';
import { compress } from '../targz';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface JavascriptsOptions {
    context: BackItUpExecuteContext;
    adapter: ioBroker.Adapter;
    backupDir: string;
    hostType?: 'Single' | 'Master' | 'Slave';
    slaveSuffix?: string;
    nameSuffix?: string;
}

let timerLog: NodeJS.Timeout | undefined;

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        timerLog = setTimeout(() => resolve(), ms);
    });
}

/**
 * Mode for the temporary script directory.
 *
 * Note: this is a string, and fs-extra's `getMode` spreads a non-number into its defaults, so the
 * value is discarded and the directory ends up with the default 0o777. Passing `{ mode: 0o2775 }`
 * - the form 36-grafana uses - would actually apply it. Left as found; changing directory
 * permissions is not something to slip into a type migration.
 */
const desiredMode = '0o2775';

export async function command(
    options: JavascriptsOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    let nameSuffix;
    if (options.hostType === 'Slave') {
        nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
    } else {
        nameSuffix = options.nameSuffix ? options.nameSuffix : '';
    }
    const fileName = join(
        options.backupDir,
        `javascripts_${getDate()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`,
    );

    options.context.fileNames.push(fileName);

    let cb = callback;

    const timer = setInterval(() => {
        if (existsSync(fileName)) {
            const stats = statSync(fileName);
            const fileSize = Math.floor(stats.size / (1024 * 1024));
            log.debug(`Packed ${fileSize}MB so far...`);
        }
    }, 5000);

    const tmpDir = join(options.backupDir, 'tmpScripts').replace(/\\/g, '/');
    // The cast only silences the type; the value handed over is unchanged (see desiredMode).
    const modeArg = desiredMode as unknown as number;

    if (!existsSync(tmpDir)) {
        try {
            ensureDirSync(tmpDir, modeArg);
            log.debug(`Created javascript_tmp directory: "${tmpDir}"`);
        } catch (err) {
            log.warn(`Javascript tmp directory "${tmpDir}" cannot created ... ${err}`);
        }
    } else {
        try {
            log.debug(`Try deleting the old javascript_tmp directory: "${tmpDir}"`);
            removeSync(tmpDir);
        } catch (err) {
            log.warn(`Javascript tmp directory "${tmpDir}" cannot deleted ... ${err}`);
        }
        if (!existsSync(tmpDir)) {
            try {
                log.debug(`old javascript_tmp directory "${tmpDir}" successfully deleted`);
                ensureDirSync(tmpDir, modeArg);
                log.debug('Created javascript_tmp directory');
            } catch (err) {
                log.warn(`Javascript tmp directory "${tmpDir}" cannot created ... ${err}`);
            }
        }
    }

    const obj = await options.adapter.getForeignObjectsAsync('script.*', 'script');

    if (obj) {
        try {
            await writeFile(join(tmpDir, 'script.json'), JSON.stringify(obj, null, 2));
        } catch (e) {
            log.error(`script.json cannot be written: ${e}`);
        }

        for (const i in obj) {
            log.debug(`found Script: ${obj[i]._id.split('.').pop()}`);
            await sleep(150);
        }
    } else {
        log.warn('Scripts not found');
    }

    if (existsSync(tmpDir) && obj) {
        compress(
            {
                src: tmpDir,
                dest: fileName,
                tar: {
                    // ignore .tar.gz and tar.sbk files when packing
                    ignore: name => extname(name) === '.gz' || extname(name) === '.sbk',
                },
            },
            // lib/targz only ever passes an error; the stdout/stderr parameters the original
            // declared here were always undefined.
            err => {
                clearInterval(timer);

                try {
                    log.debug(`Try deleting the Javascript tmp directory: "${tmpDir}"`);
                    removeSync(tmpDir);
                    if (!existsSync(tmpDir)) {
                        log.debug(`Javascript tmp directory "${tmpDir}" successfully deleted`);
                    }
                } catch (e) {
                    log.warn(`Javascript tmp directory "${tmpDir}" cannot deleted ... ${e}`);
                }

                if (err) {
                    options.context.errors.javascripts = err.toString();
                    clearTimeout(timerLog);
                    if (cb) {
                        cb(err);
                        cb = undefined;
                    }
                } else {
                    log.debug(`Backup created: ${fileName}`);
                    options.context.done.push('javascripts');
                    options.context.types.push('javascripts');
                    clearTimeout(timerLog);
                    if (cb) {
                        cb(null);
                        cb = undefined;
                    }
                }
            },
        );
    } else {
        log.warn('javascript Backup not created');
        clearTimeout(timerLog);
        // Note: the interval started above is not cleared on this path - kept as found.
        cb?.(null);
        cb = undefined;
    }
}

export const ignoreErrors = true;
