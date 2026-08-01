import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getDate } from '../tools';
import { compress } from '../targz';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface YahkaOptions {
    context: BackItUpExecuteContext;
    /** directory holding the `yahka.<n>.hapdata` folders */
    path: string;
    backupDir: string;
    hostType?: 'Single' | 'Master' | 'Slave';
    slaveSuffix?: string;
    nameSuffix?: string;
}

export function command(options: YahkaOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    const yahkaInst: string[] = [];

    let cb = callback;

    // Instances are probed by index; the run reports back once index 100 is reached without a
    // matching directory. Should a `yahka.100.hapdata` ever exist the callback is never invoked -
    // kept as found.
    for (let i = 0; i <= 100; i++) {
        const pth = join(options.path, `yahka.${i}.hapdata`);

        if (existsSync(pth)) {
            let nameSuffix;
            if (options.hostType === 'Slave') {
                nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
            } else {
                nameSuffix = options.nameSuffix ? options.nameSuffix : '';
            }

            const fileName = join(
                options.backupDir,
                `yahka.${i}_${getDate()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`,
            );

            options.context.fileNames.push(fileName);

            compress(
                {
                    src: pth,
                    dest: fileName,
                },
                // lib/targz only ever passes an error; the second parameter the original declared
                // here was always undefined.
                err => {
                    if (err) {
                        options.context.errors.yahka = err.toString();
                        if (cb) {
                            cb(err);
                            cb = undefined;
                        }
                    } else {
                        options.context.types.push(`yahka.${i}`);
                        options.context.done.push(`yahka.${i}`);
                    }
                },
            );
            yahkaInst.push(`yahka.${i}`);
            if (i === 100) {
                if (yahkaInst.length) {
                    log.debug(`found yahka database: ${yahkaInst.join(',')}`);
                } else {
                    log.warn('no yahka database found!!');
                }
            }
        } else if (!existsSync(pth) && i === 100) {
            if (yahkaInst.length) {
                log.debug(`found yahka database: ${yahkaInst.join(',')}`);
            } else {
                log.warn('no yahka database found!!');
            }
            cb?.(null, 'done');
            break;
        }
    }
}

export const ignoreErrors = true;
