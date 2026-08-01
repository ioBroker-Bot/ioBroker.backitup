import { _ } from '../tools';
import { buildErrorMessage, buildStorageList, type NotificationOptions } from '../notificationText';
import type { BackItUpScriptCallback } from './types';

interface DiscordOptions extends NotificationOptions {
    name: string;
    debugging?: boolean;
    adapter: ioBroker.Adapter;
    discord: {
        enabled?: boolean;
        instance?: string | null;
        systemLang: string;
        time?: string;
        hostName?: string;
        /** either a user id, or `<serverId>/<channelId>` */
        target?: string;
        NoticeType?: 'longDiscordNotice' | 'shortDiscordNotice';
        discordWaiting?: number;
    };
}

export function command(options: DiscordOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    setTimeout(() => {
        if (
            options.discord.enabled &&
            options.discord.target &&
            options.adapter &&
            options.discord.instance !== '' &&
            options.discord.instance !== null &&
            options.discord.instance !== undefined
        ) {
            // Send Discord Message
            if (options.debugging) {
                log.debug(`[${options.name}] used Discord-Instance: ${options.discord.instance}`);
            }

            // analyse here the info from options.context.errors and options.context.done
            const errors = Object.keys(options.context.errors);

            if (!errors.length) {
                let messageText = `${_('New %e Backup created on %t', options.discord.systemLang)}.`;
                messageText = messageText
                    .replace('%t', options.discord.time as string)
                    .replace(
                        '%e',
                        `${options.name}${options.name === 'iobroker' && options.discord.hostName ? ` (${options.discord.hostName})` : ''}`,
                    );

                if (options.discord?.NoticeType === 'longDiscordNotice') {
                    messageText += buildStorageList(options, options.discord.systemLang, true);
                }

                // Note: unlike the other channels this one has no `onlyError` check and always sends.
                sendMessage(options, log, messageText);
            } else {
                let errorMessage = buildErrorMessage(options, options.discord.systemLang);

                // Active here, unlike in most channels.
                try {
                    errorMessage = errorMessage.replaceAll('undefined', '');
                } catch {
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
function sendMessage(options: DiscordOptions, log: ioBroker.Logger, message: string): void {
    const target = options.discord.target as string;

    if (target.match(/^\d+$/)) {
        // send to a single user
        options.adapter.sendTo(
            options.discord.instance as string,
            'sendMessage',
            {
                userId: target,
                content: `**Backitup**:\n${message}`,
            },
            (ret: any) => {
                if (ret.err) {
                    log.warn(`Error sending Discord message: ${ret.err}`);
                }
            },
        );
    } else if (target.match(/^\d+\/\d+$/)) {
        // send to a server channel
        const [serverId, channelId] = target.split('/');
        options.adapter.sendTo(
            options.discord.instance as string,
            'sendMessage',
            {
                serverId,
                channelId,
                content: `**Backitup**:\n${message}`,
            },
            (ret: any) => {
                if (ret.err) {
                    log.warn(`Error sending Discord message: ${ret.err}`);
                }
            },
        );
    }
}

export const ignoreErrors = true;
export const afterBackup = true;
