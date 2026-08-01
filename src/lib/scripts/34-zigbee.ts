import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';

import { getDate } from '../tools';
import { compress } from '../targz';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface ZigbeeOptions {
    context: BackItUpExecuteContext;
    adapter: ioBroker.Adapter;
    /** directory holding the `zigbee_<n>` data folders */
    path: string;
    backupDir: string;
    hostType?: 'Single' | 'Master' | 'Slave';
    slaveSuffix?: string;
    nameSuffix?: string;
}

export async function command(
    options: ZigbeeOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    const zigbeeInst: string[] = [];

    let cb = callback;

    try {
        for (let i = 0; i <= 10; i++) {
            // Check if zigbee adapter instance exists
            const obj = await options.adapter.getForeignObjectAsync(`system.adapter.zigbee.${i}`);
            if (!obj) {
                continue;
            }

            // Check if corresponding folder exists
            const pth = join(options.path, `zigbee_${i}`);
            if (!existsSync(pth)) {
                continue;
            }

            // Determine suffix for the filename
            let nameSuffix = '';
            if (options.hostType === 'Slave') {
                nameSuffix = options.slaveSuffix || '';
            } else {
                nameSuffix = options.nameSuffix || '';
            }

            // Construct backup filename
            const fileName = join(
                options.backupDir,
                `zigbee.${i}_${getDate()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`,
            );

            options.context.fileNames.push(fileName);

            // Run compression and wait for it to finish
            await new Promise<void>(resolve => {
                compress(
                    {
                        src: pth,
                        dest: fileName,
                        tar: {
                            ignore: name => extname(name) === '.gz',
                        },
                    },
                    // lib/targz only ever passes an error; the stdout/stderr parameters the original
                    // declared here were always undefined.
                    err => {
                        if (err) {
                            options.context.errors.zigbee = err.toString();
                            if (cb) {
                                cb(err);
                                cb = undefined;
                            }
                        } else {
                            options.context.types.push(`zigbee.${i}`);
                            options.context.done.push(`zigbee.${i}`);
                        }
                        resolve();
                    },
                );
            });

            zigbeeInst.push(`zigbee.${i}`);
        }

        // Log summary
        if (zigbeeInst.length) {
            log.debug(`Found zigbee databases: ${zigbeeInst.join(', ')}`);
        } else {
            log.warn('No zigbee databases found!');
        }

        // Final callback
        cb?.(null, 'done');
    } catch (err) {
        log.error(`Error during zigbee backup: ${(err as Error).message}`);
        cb?.(err as Error);
    }
}

export const ignoreErrors = true;
