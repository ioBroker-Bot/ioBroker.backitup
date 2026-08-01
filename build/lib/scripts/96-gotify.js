"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.afterBackup = exports.ignoreErrors = void 0;
exports.command = command;
const tools_1 = require("../tools");
const notificationText_1 = require("../notificationText");
function command(options, log, callback) {
    setTimeout(() => {
        if (options.gotify.enabled &&
            options.adapter &&
            options.gotify.instance !== '' &&
            options.gotify.instance !== null &&
            options.gotify.instance !== undefined) {
            // Send Gotify Message
            if (options.debugging) {
                log.debug(`[${options.name}] used Gotify-Instance: ${options.gotify.instance}`);
            }
            // analyse here the info from options.context.errors and options.context.done
            const errors = Object.keys(options.context.errors);
            if (!errors.length) {
                let messageText = `${(0, tools_1._)('New %e Backup created on %t', options.gotify.systemLang)}.`;
                messageText = messageText
                    .replace('%t', options.gotify.time)
                    .replace('%e', `${options.name}${options.name === 'iobroker' && options.gotify.hostName ? ` (${options.gotify.hostName})` : ''}`);
                let storageOptions = '';
                // Deliberately not the shared buildStorageList: this variant guards its entries
                // differently - `options.onedrive` is dereferenced without a check, and the "Local"
                // line only appears when a CIFS block exists. Both are kept as found.
                if (options.gotify?.NoticeType === 'longGotifyNotice') {
                    storageOptions = `\n\n${(0, tools_1._)('Storage location', options.gotify.systemLang)}:\n`;
                    let storageNum = 1;
                    if (options.ftp && options.ftp.enabled) {
                        const m = `${storageNum++}. ${(0, tools_1._)('FTP', options.gotify.systemLang)} (%h%d)%k`;
                        storageOptions += m
                            .replace('%h', options.ftp.host)
                            .replace('%d', options.ftp.dir)
                            .replace('%k', '\n');
                    }
                    if (options.cifs && options.cifs.enabled) {
                        const m = `${storageNum++}. ${(0, tools_1._)(`NAS (${options.cifs.mountType})`, options.gotify.systemLang)} (%h%d)%k`;
                        storageOptions += m
                            .replace('%h', options.cifs.mount)
                            .replace('%d', options.cifs.dir)
                            .replace('%k', '\n');
                    }
                    if (options.dropbox && options.dropbox.enabled) {
                        const m = `${storageNum++}. ${(0, tools_1._)('Dropbox', options.gotify.systemLang)} (%d)%k`;
                        storageOptions += m.replace('%d', options.dropbox.dir).replace('%k', '\n');
                    }
                    // No optional chaining here - throws when onedrive is missing entirely, as before.
                    if (options.onedrive.enabled) {
                        const m = `${storageNum++}. ${(0, tools_1._)('OneDrive', options.gotify.systemLang)} (%d)%k`;
                        storageOptions += m.replace('%d', options.onedrive.dir).replace('%k', '\n');
                    }
                    if (options.googledrive && options.googledrive.enabled) {
                        const m = `${storageNum++}. ${(0, tools_1._)('Google Drive', options.gotify.systemLang)} (%d)%k`;
                        storageOptions += m.replace('%d', options.googledrive.dir).replace('%k', '\n');
                    }
                    if (options.webdav && options.webdav.enabled) {
                        const m = `${storageNum++}. ${(0, tools_1._)('WebDAV', options.gotify.systemLang)} (%d)%k`;
                        storageOptions += m.replace('%d', options.webdav.dir).replace('%k', '\n');
                    }
                    if (options.cifs && !options.cifs.enabled) {
                        const m = `${storageNum++}. ${(0, tools_1._)('Local', options.gotify.systemLang)} (%d)%k`;
                        storageOptions += m.replace('%d', options.backupDir).replace('%k', '\n');
                    }
                }
                messageText += storageOptions;
                // The `=== 'false'` arm covers instance configurations that stored the flag as a string.
                if (options.gotify.onlyError === false || options.gotify.onlyError === 'false') {
                    options.adapter.sendTo(options.gotify.instance, 'send', {
                        priority: 4,
                        title: 'Backitup:',
                        contentType: 'text/markdown',
                        message: messageText,
                    });
                }
            }
            else {
                let errorMessage = (0, notificationText_1.buildErrorMessage)(options, options.gotify.systemLang);
                // Active here, unlike in most channels.
                try {
                    errorMessage = errorMessage.replaceAll('undefined', '');
                }
                catch {
                    // ignore
                }
                options.adapter.sendTo(options.gotify.instance, 'send', {
                    priority: 4,
                    title: 'Backitup:',
                    contentType: 'text/markdown',
                    message: errorMessage,
                });
            }
        }
        callback?.();
    }, options.gotify.gotifyWaiting);
}
exports.ignoreErrors = true;
exports.afterBackup = true;
//# sourceMappingURL=96-gotify.js.map