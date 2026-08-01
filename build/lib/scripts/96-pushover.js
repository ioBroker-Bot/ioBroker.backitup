"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.afterBackup = exports.ignoreErrors = void 0;
exports.command = command;
const tools_1 = require("../tools");
const notificationText_1 = require("../notificationText");
function command(options, log, callback) {
    setTimeout(() => {
        if (options.pushover.enabled &&
            options.adapter &&
            options.pushover.instance !== '' &&
            options.pushover.instance !== null &&
            options.pushover.instance !== undefined) {
            // Send pushover Message
            if (options.debugging) {
                log.debug(`[${options.name}] used pushover-Instance: ${options.pushover.instance}`);
            }
            // analyse here the info from options.context.errors and options.context.done
            const errors = Object.keys(options.context.errors);
            // Older instance configurations stored these flags as strings.
            const silent = options.pushover.SilentNotice === 'true' || options.pushover.SilentNotice === true;
            if (!errors.length) {
                let messageText = `${(0, tools_1._)('New %e Backup created on %t', options.pushover.systemLang)}.`;
                messageText = messageText
                    .replace('%t', options.pushover.time)
                    .replace('%e', `${options.name}${options.name === 'iobroker' && options.pushover.hostName ? ` (${options.pushover.hostName})` : ''}`);
                if (options.pushover?.NoticeType === 'longPushoverNotice') {
                    messageText += (0, notificationText_1.buildStorageList)(options, options.pushover.systemLang);
                }
                if (options.pushover.onlyError === false || options.pushover.onlyError === 'false') {
                    if (silent) {
                        options.adapter.sendTo(options.pushover.instance, 'send', {
                            message: `<b>Backitup:</b>\n${messageText}`,
                            sound: '',
                            priority: -1,
                            title: 'Backitup',
                            device: options.pushover.deviceID,
                            html: 1,
                        });
                    }
                    else {
                        options.adapter.sendTo(options.pushover.instance, 'send', {
                            message: `<b>Backitup:</b>\n${messageText}`,
                            sound: '',
                            title: 'Backitup',
                            device: options.pushover.deviceID,
                            html: 1,
                        });
                    }
                }
            }
            else {
                const errorMessage = (0, notificationText_1.buildErrorMessage)(options, options.pushover.systemLang);
                if (silent) {
                    options.adapter.sendTo(options.pushover.instance, 'send', {
                        message: `Backitup:\n${errorMessage}`,
                        sound: '',
                        priority: -1,
                        title: 'Backitup',
                        device: options.pushover.deviceID,
                    });
                }
                else {
                    options.adapter.sendTo(options.pushover.instance, 'send', {
                        message: `Backitup:\n${errorMessage}`,
                        sound: '',
                        title: 'Backitup',
                        device: options.pushover.deviceID,
                    });
                }
            }
        }
        callback?.();
    }, options.pushover.pushoverWaiting);
}
exports.ignoreErrors = true;
exports.afterBackup = true;
//# sourceMappingURL=96-pushover.js.map