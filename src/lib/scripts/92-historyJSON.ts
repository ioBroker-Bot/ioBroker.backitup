import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';

import { _, getTimeString } from '../tools';
import { buildHistoryErrorLine } from '../notificationText';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface HistoryTarget {
    enabled?: boolean;
}

interface HistoryJsonOptions {
    context: BackItUpExecuteContext;
    name: string;
    adapter: ioBroker.Adapter;
    timestamp?: number;
    ftp?: HistoryTarget;
    cifs?: HistoryTarget;
    dropbox?: HistoryTarget;
    webdav?: HistoryTarget;
    googledrive?: HistoryTarget;
    onedrive?: HistoryTarget;
    historyJSON: {
        enabled?: boolean;
        systemLang: string;
        entriesNumber: number;
    };
}

interface HistoryJsonEntry {
    date: string;
    name: string | undefined;
    type: string;
    storage: string | string[];
    filesize: string | null;
    error: string;
    timestamp: number | undefined;
}

/**
 * Size of the produced archive, in whole megabytes.
 *
 * @param fileName archive to measure, if it exists
 * @param log adapter logger
 */
async function fileSizeCheck(fileName: string | undefined, log: ioBroker.Logger): Promise<string | null> {
    let fileSize: string | null = null;

    if (fileName && existsSync(fileName)) {
        const stats = await stat(fileName).catch(err => log.warn(`Filesize error: ${err}`));

        fileSize = stats ? `${Math.floor(stats.size / (1024 * 1024))} MB` : null;
    }
    return fileSize;
}

export async function command(
    options: HistoryJsonOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    // Build DP JSON
    if (options.historyJSON.enabled && options.adapter) {
        let fileName: string | undefined;
        let cb = callback;

        try {
            const fileNames: string[] = JSON.parse(JSON.stringify(options.context.fileNames));
            fileName = fileNames.shift();

            if (fileName && existsSync(fileName)) {
                fileName = fileName ? fileName.replace(/\\/g, '/') : undefined;
            }
        } catch (err) {
            log.error(`FileName error: ${err}`);
        }

        try {
            const state = await options.adapter.getStateAsync('history.json');

            // Note: when the state is missing or empty nothing below runs and the callback is never
            // invoked, which stalls the step chain. Left as found.
            if (state && state.val) {
                const historyListJSON = state.val as string;
                let historyArrayJSON: HistoryJsonEntry[] | undefined;

                if (historyListJSON !== undefined) {
                    try {
                        historyArrayJSON = JSON.parse(historyListJSON);
                    } catch (err) {
                        log.error(`history error: ${err} Please reinstall BackItUp and run "iobroker fix"!!`);
                    }
                }

                const errors = Object.keys(options.context.errors);
                let errorMessage = '';

                if (errors.length) {
                    errorMessage = buildHistoryErrorLine(options.context.errors, options.historyJSON.systemLang);
                } else {
                    errorMessage = 'none';
                }

                const storage: string[] = [];

                const targets: [HistoryTarget | undefined, string][] = [
                    [options.ftp, 'FTP'],
                    [options.cifs, 'NAS / Copy'],
                    [options.dropbox, 'Dropbox'],
                    [options.webdav, 'WebDAV'],
                    [options.googledrive, 'Google Drive'],
                    [options.onedrive, 'OneDrive'],
                ];
                for (const [target, label] of targets) {
                    if (target && target.enabled) {
                        storage.push(_(label, options.historyJSON.systemLang));
                    }
                }
                if (!storage.length) {
                    storage.push(_('Only stored locally', options.historyJSON.systemLang));
                }

                // push history to json
                try {
                    // Throws when the state did not hold parsable JSON - reported through the
                    // callback below, as before.
                    historyArrayJSON!.unshift({
                        date: getTimeString(options.historyJSON.systemLang),
                        name: fileName ? fileName.split('/').pop() : undefined,
                        type: options.name,
                        storage: storage.length > 1 ? storage : storage[0],
                        filesize: await fileSizeCheck(fileName, log),
                        error: errorMessage,
                        timestamp: options.timestamp,
                    });
                } catch (err) {
                    cb?.(`history json could not be created: ${err}`);
                }

                if (historyArrayJSON && historyArrayJSON.length > options.historyJSON.entriesNumber) {
                    historyArrayJSON.splice(
                        options.historyJSON.entriesNumber,
                        historyArrayJSON.length - options.historyJSON.entriesNumber,
                    );
                }

                try {
                    await options.adapter.setStateAsync('history.json', {
                        val: JSON.stringify(historyArrayJSON),
                        ack: true,
                    });
                    log.debug('new history json values created');
                } catch (err) {
                    cb?.(`history json could not be created: ${err}`);
                }

                cb?.(null, 'done');
                cb = undefined;
            }
        } catch (err) {
            cb?.(`history json could not be created: ${err}`);
        }
    } else {
        callback?.();
    }
}

export const ignoreErrors = true;
export const afterBackup = true;
