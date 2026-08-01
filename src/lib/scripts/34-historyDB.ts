import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getDate } from '../tools';
import { compress } from '../targz';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface HistoryDbOptions {
    context: BackItUpExecuteContext;
    /** file or directory holding the history database */
    path: string;
    backupDir: string;
    hostType?: 'Single' | 'Master' | 'Slave';
    slaveSuffix?: string;
    nameSuffix?: string;
}

export function command(options: HistoryDbOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    let nameSuffix;
    if (options.hostType === 'Slave') {
        nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
    } else {
        nameSuffix = options.nameSuffix ? options.nameSuffix : '';
    }

    const fileName = join(
        options.backupDir,
        `historyDB_${getDate()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`,
    );
    const sourcePth = join(options.path).replace(/\\/g, '/');

    options.context.fileNames.push(fileName);

    const timer = setInterval(() => {
        if (existsSync(fileName)) {
            const stats = statSync(fileName);
            const fileSize = Math.floor(stats.size / (1024 * 1024));
            log.debug(`Packed ${fileSize}MB so far...`);
        }
    }, 10000);

    let name: string | undefined;
    let pth: string | undefined;

    if (existsSync(sourcePth)) {
        const stat = statSync(sourcePth);
        if (!stat.isDirectory()) {
            // A single file: pack its directory and filter down to that one entry.
            const parts = sourcePth.replace(/\\/g, '/').split('/');
            name = parts.pop();
            pth = parts.join('/');
        } else {
            pth = sourcePth;
        }
    }
    log.debug('compress from historyDB started ...');

    let cb = callback;

    compress(
        {
            src: pth,
            dest: fileName,
            tar: {
                ignore: nm => !!name && name !== nm.replace(/\\/g, '/').split('/').pop(),
            },
        },
        // lib/targz only ever passes an error; the stdout/stderr parameters the original declared
        // here were always undefined, so the `stderr && log.error(stderr)` line never ran.
        err => {
            clearInterval(timer);

            if (err) {
                options.context.errors.historyDB = err.toString();
                if (cb) {
                    cb(err);
                    cb = undefined;
                }
            } else {
                log.debug(`Backup created: ${fileName}`);
                options.context.done.push('historyDB');
                options.context.types.push('historyDB');
                if (cb) {
                    cb(null);
                    cb = undefined;
                }
            }
        },
    );
}

export const ignoreErrors = true;
