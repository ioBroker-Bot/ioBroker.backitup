"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.afterBackup = exports.ignoreErrors = void 0;
exports.command = command;
const tools_1 = require("../tools");
const notificationText_1 = require("../notificationText");
function command(options, log, callback) {
    setTimeout(() => {
        if (options.signal.enabled &&
            options.adapter &&
            options.signal.instance !== '' &&
            options.signal.instance !== null &&
            options.signal.instance !== undefined) {
            // Send signal Message
            if (options.debugging) {
                log.debug(`[${options.name}] used Signal-Instance: ${options.signal.instance}`);
            }
            // analyse here the info from options.context.errors and options.context.done
            const errors = Object.keys(options.context.errors);
            if (!errors.length) {
                let messageText = `${(0, tools_1._)('New %e Backup created on %t', options.signal.systemLang)}.`;
                messageText = messageText
                    .replace('%t', options.signal.time)
                    .replace('%e', `${options.name}${options.name === 'iobroker' && options.signal.hostName ? ` (${options.signal.hostName})` : ''}`);
                if (options.signal?.NoticeType === 'longSignalNotice') {
                    messageText += (0, notificationText_1.buildStorageList)(options, options.signal.systemLang);
                }
                // The `=== 'false'` arm covers instance configurations that stored the flag as a string.
                if (options.signal.onlyError === false || options.signal.onlyError === 'false') {
                    options.adapter.sendTo(options.signal.instance, 'send', {
                        text: `Backitup:\n${messageText}`,
                    });
                }
            }
            else {
                const errorMessage = (0, notificationText_1.buildErrorMessage)(options, options.signal.systemLang);
                options.adapter.sendTo(options.signal.instance, 'send', {
                    text: `Backitup:\n${errorMessage}`,
                });
            }
        }
        callback?.();
    }, options.signal.signalWaiting);
}
exports.ignoreErrors = true;
exports.afterBackup = true;
//# sourceMappingURL=96-signal.js.map