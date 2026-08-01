"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.afterBackup = exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const tools_1 = require("../tools");
const notificationText_1 = require("../notificationText");
/**
 * Size of the produced archive, in whole megabytes.
 *
 * @param fileName archive to measure, if it exists
 * @param log adapter logger
 */
async function fileSizeCheck(fileName, log) {
    let fileSize = null;
    if (fileName && (0, node_fs_1.existsSync)(fileName)) {
        const stats = await (0, promises_1.stat)(fileName).catch(err => log.warn(`Filesize error: ${err}`));
        fileSize = stats ? `${Math.floor(stats.size / (1024 * 1024))} MB` : null;
    }
    return fileSize;
}
async function command(options, log, callback) {
    // Build DP JSON
    if (options.historyJSON.enabled && options.adapter) {
        let fileName;
        let cb = callback;
        try {
            const fileNames = JSON.parse(JSON.stringify(options.context.fileNames));
            fileName = fileNames.shift();
            if (fileName && (0, node_fs_1.existsSync)(fileName)) {
                fileName = fileName ? fileName.replace(/\\/g, '/') : undefined;
            }
        }
        catch (err) {
            log.error(`FileName error: ${err}`);
        }
        try {
            const state = await options.adapter.getStateAsync('history.json');
            // Note: when the state is missing or empty nothing below runs and the callback is never
            // invoked, which stalls the step chain. Left as found.
            if (state && state.val) {
                const historyListJSON = state.val;
                let historyArrayJSON;
                if (historyListJSON !== undefined) {
                    try {
                        historyArrayJSON = JSON.parse(historyListJSON);
                    }
                    catch (err) {
                        log.error(`history error: ${err} Please reinstall BackItUp and run "iobroker fix"!!`);
                    }
                }
                const errors = Object.keys(options.context.errors);
                let errorMessage = '';
                if (errors.length) {
                    errorMessage = (0, notificationText_1.buildHistoryErrorLine)(options.context.errors, options.historyJSON.systemLang);
                }
                else {
                    errorMessage = 'none';
                }
                const storage = [];
                const targets = [
                    [options.ftp, 'FTP'],
                    [options.cifs, 'NAS / Copy'],
                    [options.dropbox, 'Dropbox'],
                    [options.webdav, 'WebDAV'],
                    [options.googledrive, 'Google Drive'],
                    [options.onedrive, 'OneDrive'],
                ];
                for (const [target, label] of targets) {
                    if (target && target.enabled) {
                        storage.push((0, tools_1._)(label, options.historyJSON.systemLang));
                    }
                }
                if (!storage.length) {
                    storage.push((0, tools_1._)('Only stored locally', options.historyJSON.systemLang));
                }
                // push history to json
                try {
                    // Throws when the state did not hold parsable JSON - reported through the
                    // callback below, as before.
                    historyArrayJSON.unshift({
                        date: (0, tools_1.getTimeString)(options.historyJSON.systemLang),
                        name: fileName ? fileName.split('/').pop() : undefined,
                        type: options.name,
                        storage: storage.length > 1 ? storage : storage[0],
                        filesize: await fileSizeCheck(fileName, log),
                        error: errorMessage,
                        timestamp: options.timestamp,
                    });
                }
                catch (err) {
                    cb?.(`history json could not be created: ${err}`);
                }
                if (historyArrayJSON && historyArrayJSON.length > options.historyJSON.entriesNumber) {
                    historyArrayJSON.splice(options.historyJSON.entriesNumber, historyArrayJSON.length - options.historyJSON.entriesNumber);
                }
                try {
                    await options.adapter.setStateAsync('history.json', {
                        val: JSON.stringify(historyArrayJSON),
                        ack: true,
                    });
                    log.debug('new history json values created');
                }
                catch (err) {
                    cb?.(`history json could not be created: ${err}`);
                }
                cb?.(null, 'done');
                cb = undefined;
            }
        }
        catch (err) {
            cb?.(`history json could not be created: ${err}`);
        }
    }
    else {
        callback?.();
    }
}
exports.ignoreErrors = true;
exports.afterBackup = true;
//# sourceMappingURL=92-historyJSON.js.map