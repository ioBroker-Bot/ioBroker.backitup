"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.afterBackup = exports.ignoreErrors = void 0;
exports.command = command;
const tools_1 = require("../tools");
const notificationText_1 = require("../notificationText");
async function command(options, log, callback) {
    if (options.historyHTML.enabled && options.adapter) {
        let historyArray = [];
        // Cleared after the success call so a throw from it cannot report a second time.
        let cb = callback;
        try {
            // function for entering the backup execution in the history-log
            let historyList;
            const state = await options.adapter.getStateAsync('history.html');
            if (state && state.val) {
                historyList = state.val;
                if (historyList ===
                    `<span class="backup-type-total">${(0, tools_1._)('No backups yet', options.historyHTML.systemLang)}</span>`) {
                    historyList = '';
                }
            }
            // analyse here the info from options.context.errors and options.context.done
            if (historyList !== undefined) {
                try {
                    historyArray = historyList.split('&nbsp;');
                }
                catch (err) {
                    log.error(`history error: ${err} Please reinstall BackItUp and run "iobroker fix"!!`);
                }
            }
            const timeStamp = (0, tools_1.getTimeString)(options.historyHTML.systemLang);
            let doneSomething = false;
            const errors = Object.keys(options.context.errors);
            const entry = (text) => `<span class="backup-type-${options.name}">${timeStamp} - ${(0, tools_1._)('Type', options.historyHTML.systemLang)}: ${options.name} - ${text}</span>`;
            if (!errors.length) {
                const targets = [
                    [options.ftp, 'FTP-Backup: Yes'],
                    [options.cifs, 'NAS: Yes'],
                    [options.dropbox, 'Dropbox: Yes'],
                    [options.webdav, 'WebDAV: Yes'],
                    [options.googledrive, 'Google Drive: Yes'],
                    [options.onedrive, 'Onedrive: Yes'],
                ];
                for (const [target, label] of targets) {
                    if (target && target.enabled) {
                        historyArray.unshift(entry((0, tools_1._)(label, options.historyHTML.systemLang)));
                        doneSomething = true;
                    }
                }
                if (!doneSomething) {
                    historyArray.unshift(entry((0, tools_1._)('Only stored locally', options.historyHTML.systemLang)));
                }
            }
            else {
                historyArray.unshift(entry((0, notificationText_1.buildHistoryErrorLine)(options.context.errors, options.historyHTML.systemLang)));
            }
            if (historyArray.length > options.historyHTML.entriesNumber) {
                historyArray.splice(options.historyHTML.entriesNumber, historyArray.length - options.historyHTML.entriesNumber);
            }
            log.debug('new history html values created');
            await options.adapter.setStateAsync('history.html', { val: historyArray.join('&nbsp;'), ack: true });
            cb?.(null, 'done');
            cb = undefined;
        }
        catch (err) {
            cb?.(`history html could not be created: ${err}`);
        }
    }
    else {
        callback?.();
    }
}
exports.ignoreErrors = true;
exports.afterBackup = true;
//# sourceMappingURL=90-historyHTML.js.map