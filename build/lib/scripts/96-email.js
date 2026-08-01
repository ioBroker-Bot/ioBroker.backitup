"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.afterBackup = exports.ignoreErrors = void 0;
exports.command = command;
const tools_1 = require("../tools");
const notificationText_1 = require("../notificationText");
function command(options, log, callback) {
    setTimeout(() => {
        if (options.email.enabled &&
            options.adapter &&
            options.email.instance !== '' &&
            options.email.instance !== null &&
            options.email.instance !== undefined) {
            // Send E-Mail Message
            if (options.debugging) {
                log.debug(`[${options.name}] used E-Mail-Instance: ${options.email.instance}`);
            }
            // analyse here the info from options.context.errors and options.context.done
            const errors = Object.keys(options.context.errors);
            if (!errors.length) {
                let messageText = `${(0, tools_1._)('New %e Backup created on %t', options.email.systemLang)}.`;
                messageText = messageText
                    .replace('%t', options.email.time)
                    .replace('%e', `${options.name}${options.name === 'iobroker' && options.email.hostName ? ` (${options.email.hostName})` : ''}`);
                if (options.email?.NoticeType === 'longEmailNotice') {
                    messageText += (0, notificationText_1.buildStorageList)(options, options.email.systemLang);
                }
                // The `=== 'false'` arm covers instance configurations that stored the flag as a string.
                if (options.email.onlyError === false || options.email.onlyError === 'false') {
                    options.adapter.sendTo(options.email.instance, 'send', {
                        text: `Backitup:\n${messageText}`,
                        to: options.email.emailReceiver,
                        subject: 'Backitup',
                        from: options.email.emailSender,
                    });
                }
            }
            else {
                const errorMessage = (0, notificationText_1.buildErrorMessage)(options, options.email.systemLang);
                options.adapter.sendTo(options.email.instance, 'send', {
                    text: `Backitup:\n${errorMessage}`,
                    to: options.email.emailReceiver,
                    subject: 'Backitup Error Message',
                    from: options.email.emailSender,
                });
            }
        }
        callback?.();
    }, options.email.emailWaiting);
}
exports.ignoreErrors = true;
exports.afterBackup = true;
//# sourceMappingURL=96-email.js.map