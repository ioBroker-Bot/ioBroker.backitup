import { _, getTimeString } from '../tools';
import { buildHistoryErrorLine } from '../notificationText';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface HistoryTarget {
    enabled?: boolean;
}

interface HistoryHtmlOptions {
    context: BackItUpExecuteContext;
    name: string;
    adapter: ioBroker.Adapter;
    ftp?: HistoryTarget;
    cifs?: HistoryTarget;
    dropbox?: HistoryTarget;
    webdav?: HistoryTarget;
    googledrive?: HistoryTarget;
    onedrive?: HistoryTarget;
    historyHTML: {
        enabled?: boolean;
        systemLang: string;
        entriesNumber: number;
    };
}

export async function command(
    options: HistoryHtmlOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    if (options.historyHTML.enabled && options.adapter) {
        let historyArray: string[] = [];
        // Cleared after the success call so a throw from it cannot report a second time.
        let cb = callback;
        try {
            // function for entering the backup execution in the history-log
            let historyList: string | undefined;
            const state = await options.adapter.getStateAsync('history.html');

            if (state && state.val) {
                historyList = state.val as string;
                if (
                    historyList ===
                    `<span class="backup-type-total">${_('No backups yet', options.historyHTML.systemLang)}</span>`
                ) {
                    historyList = '';
                }
            }

            // analyse here the info from options.context.errors and options.context.done
            if (historyList !== undefined) {
                try {
                    historyArray = historyList.split('&nbsp;');
                } catch (err) {
                    log.error(`history error: ${err} Please reinstall BackItUp and run "iobroker fix"!!`);
                }
            }
            const timeStamp = getTimeString(options.historyHTML.systemLang);
            let doneSomething = false;

            const errors = Object.keys(options.context.errors);

            const entry = (text: string): string =>
                `<span class="backup-type-${options.name}">${timeStamp} - ${_('Type', options.historyHTML.systemLang)}: ${options.name} - ${text}</span>`;

            if (!errors.length) {
                const targets: [HistoryTarget | undefined, string][] = [
                    [options.ftp, 'FTP-Backup: Yes'],
                    [options.cifs, 'NAS: Yes'],
                    [options.dropbox, 'Dropbox: Yes'],
                    [options.webdav, 'WebDAV: Yes'],
                    [options.googledrive, 'Google Drive: Yes'],
                    [options.onedrive, 'Onedrive: Yes'],
                ];

                for (const [target, label] of targets) {
                    if (target && target.enabled) {
                        historyArray.unshift(entry(_(label, options.historyHTML.systemLang)));
                        doneSomething = true;
                    }
                }

                if (!doneSomething) {
                    historyArray.unshift(entry(_('Only stored locally', options.historyHTML.systemLang)));
                }
            } else {
                historyArray.unshift(
                    entry(buildHistoryErrorLine(options.context.errors, options.historyHTML.systemLang)),
                );
            }

            if (historyArray.length > options.historyHTML.entriesNumber) {
                historyArray.splice(
                    options.historyHTML.entriesNumber,
                    historyArray.length - options.historyHTML.entriesNumber,
                );
            }
            log.debug('new history html values created');
            await options.adapter.setStateAsync('history.html', { val: historyArray.join('&nbsp;'), ack: true });

            cb?.(null, 'done');
            cb = undefined;
        } catch (err) {
            cb?.(`history html could not be created: ${err}`);
        }
    } else {
        callback?.();
    }
}

export const ignoreErrors = true;
export const afterBackup = true;
