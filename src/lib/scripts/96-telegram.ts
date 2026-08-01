import { _ } from '../tools';
import { buildErrorMessage, buildStorageList, type NotificationOptions } from '../notificationText';
import type { BackItUpScriptCallback } from './types';

interface TelegramOptions extends NotificationOptions {
    name: string;
    debugging?: boolean;
    adapter: ioBroker.Adapter;
    telegram: {
        enabled?: boolean;
        instance?: string | null;
        systemLang: string;
        time?: string;
        hostName?: string;
        User?: string;
        SilentNotice?: boolean;
        onlyError?: boolean;
        NoticeType?: 'longTelegramNotice' | 'shortTelegramNotice';
        telegramWaiting?: number;
    };
}

export function command(options: TelegramOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    setTimeout(() => {
        if (
            options.telegram.enabled &&
            options.adapter &&
            options.telegram.instance !== '' &&
            options.telegram.instance !== null &&
            options.telegram.instance !== undefined
        ) {
            // Send Telegram Message
            if (options.debugging) {
                log.debug(`[${options.name}] used Telegram-Instance: ${options.telegram.instance}`);
            }

            // analyse here the info from options.context.errors and options.context.done
            const errors = Object.keys(options.context.errors);

            if (!errors.length) {
                let messageText = `${_('New %e Backup created on %t', options.telegram.systemLang)}.`;
                messageText = messageText
                    .replace('%t', options.telegram.time as string)
                    .replace(
                        '%e',
                        `${options.name}${options.name === 'iobroker' && options.telegram.hostName ? ` (${options.telegram.hostName})` : ''}`,
                    );

                if (options.telegram?.NoticeType === 'longTelegramNotice') {
                    messageText += buildStorageList(options, options.telegram.systemLang);
                }

                // The `=== 'false'` arm covers instance configurations that stored the flag as a string.
                if (options.telegram.onlyError === false || (options.telegram.onlyError as unknown) === 'false') {
                    if (options.telegram.User && options.telegram.User === 'allTelegramUsers') {
                        options.adapter.sendTo(options.telegram.instance, 'send', {
                            text: `<b>Backitup:</b>\n${messageText}`,
                            disable_notification: options.telegram.SilentNotice,
                            parse_mode: 'HTML',
                        });
                    } else {
                        options.adapter.sendTo(options.telegram.instance, 'send', {
                            user: options.telegram.User,
                            text: `<b>Backitup:</b>\n${messageText}`,
                            disable_notification: options.telegram.SilentNotice,
                            parse_mode: 'HTML',
                        });
                    }
                }
            } else {
                const errorMessage = buildErrorMessage(options, options.telegram.systemLang);

                if (options.telegram.User && options.telegram.User === 'allTelegramUsers') {
                    options.adapter.sendTo(options.telegram.instance, 'send', {
                        text: `Backitup:\n${errorMessage}`,
                        disable_notification: options.telegram.SilentNotice,
                    });
                } else {
                    options.adapter.sendTo(options.telegram.instance, 'send', {
                        user: options.telegram.User,
                        text: `Backitup:\n${errorMessage}`,
                        disable_notification: options.telegram.SilentNotice,
                    });
                }
            }
        }
        callback?.();
    }, options.telegram.telegramWaiting);
}

export const ignoreErrors = true;
export const afterBackup = true;
