"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.afterBackup = exports.ignoreErrors = void 0;
exports.command = command;
const tools_1 = require("../tools");
const notificationText_1 = require("../notificationText");
function command(options, log, callback) {
    setTimeout(() => {
        if (options.discord.enabled &&
            options.discord.target &&
            options.adapter &&
            options.discord.instance !== '' &&
            options.discord.instance !== null &&
            options.discord.instance !== undefined) {
            // Send Discord Message
            if (options.debugging) {
                log.debug(`[${options.name}] used Discord-Instance: ${options.discord.instance}`);
            }
            // analyse here the info from options.context.errors and options.context.done
            const errors = Object.keys(options.context.errors);
            if (!errors.length) {
                let messageText = `${(0, tools_1._)('New %e Backup created on %t', options.discord.systemLang)}.`;
                messageText = messageText
                    .replace('%t', options.discord.time)
                    .replace('%e', `${options.name}${options.name === 'iobroker' && options.discord.hostName ? ` (${options.discord.hostName})` : ''}`);
                if (options.discord?.NoticeType === 'longDiscordNotice') {
                    messageText += (0, notificationText_1.buildStorageList)(options, options.discord.systemLang, true);
                }
                // Note: unlike the other channels this one has no `onlyError` check and always sends.
                sendMessage(options, log, messageText);
            }
            else {
                let errorMessage = (0, notificationText_1.buildErrorMessage)(options, options.discord.systemLang);
                // Active here, unlike in most channels.
                try {
                    errorMessage = errorMessage.replaceAll('undefined', '');
                }
                catch {
                    // ignore
                }
                sendMessage(options, log, errorMessage);
            }
        }
        callback?.();
    }, options.discord.discordWaiting);
}
/**
 * Delivers to a single user or to a server channel, depending on how `target` is written.
 *
 * @param options script options
 * @param log adapter logger
 * @param message text to deliver
 */
function sendMessage(options, log, message) {
    const target = options.discord.target;
    if (target.match(/^\d+$/)) {
        // send to a single user
        options.adapter.sendTo(options.discord.instance, 'sendMessage', {
            userId: target,
            content: `**Backitup**:\n${message}`,
        }, (ret) => {
            if (ret.err) {
                log.warn(`Error sending Discord message: ${ret.err}`);
            }
        });
    }
    else if (target.match(/^\d+\/\d+$/)) {
        // send to a server channel
        const [serverId, channelId] = target.split('/');
        options.adapter.sendTo(options.discord.instance, 'sendMessage', {
            serverId,
            channelId,
            content: `**Backitup**:\n${message}`,
        }, (ret) => {
            if (ret.err) {
                log.warn(`Error sending Discord message: ${ret.err}`);
            }
        });
    }
}
exports.ignoreErrors = true;
exports.afterBackup = true;
//# sourceMappingURL=96-discord.js.map