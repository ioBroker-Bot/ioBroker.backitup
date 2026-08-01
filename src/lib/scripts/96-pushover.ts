import { _ } from '../tools';
import { buildErrorMessage, buildStorageList, type NotificationOptions } from '../notificationText';
import type { BackItUpScriptCallback } from './types';

interface PushoverOptions extends NotificationOptions {
    name: string;
    debugging?: boolean;
    adapter: ioBroker.Adapter;
    pushover: {
        enabled?: boolean;
        instance?: string | null;
        systemLang: string;
        time?: string;
        hostName?: string;
        deviceID?: string;
        SilentNotice?: boolean;
        onlyError?: boolean;
        NoticeType?: 'longPushoverNotice' | 'shortPushoverNotice';
        pushoverWaiting?: number;
    };
}

export function command(options: PushoverOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    setTimeout(() => {
        if (
            options.pushover.enabled &&
            options.adapter &&
            options.pushover.instance !== '' &&
            options.pushover.instance !== null &&
            options.pushover.instance !== undefined
        ) {
            // Send pushover Message
            if (options.debugging) {
                log.debug(`[${options.name}] used pushover-Instance: ${options.pushover.instance}`);
            }

            // analyse here the info from options.context.errors and options.context.done
            const errors = Object.keys(options.context.errors);

            // Older instance configurations stored these flags as strings.
            const silent =
                (options.pushover.SilentNotice as unknown) === 'true' || options.pushover.SilentNotice === true;

            if (!errors.length) {
                let messageText = `${_('New %e Backup created on %t', options.pushover.systemLang)}.`;
                messageText = messageText
                    .replace('%t', options.pushover.time as string)
                    .replace(
                        '%e',
                        `${options.name}${options.name === 'iobroker' && options.pushover.hostName ? ` (${options.pushover.hostName})` : ''}`,
                    );

                if (options.pushover?.NoticeType === 'longPushoverNotice') {
                    messageText += buildStorageList(options, options.pushover.systemLang);
                }

                if (options.pushover.onlyError === false || (options.pushover.onlyError as unknown) === 'false') {
                    if (silent) {
                        options.adapter.sendTo(options.pushover.instance, 'send', {
                            message: `<b>Backitup:</b>\n${messageText}`,
                            sound: '',
                            priority: -1,
                            title: 'Backitup',
                            device: options.pushover.deviceID,
                            html: 1,
                        });
                    } else {
                        options.adapter.sendTo(options.pushover.instance, 'send', {
                            message: `<b>Backitup:</b>\n${messageText}`,
                            sound: '',
                            title: 'Backitup',
                            device: options.pushover.deviceID,
                            html: 1,
                        });
                    }
                }
            } else {
                const errorMessage = buildErrorMessage(options, options.pushover.systemLang);

                if (silent) {
                    options.adapter.sendTo(options.pushover.instance, 'send', {
                        message: `Backitup:\n${errorMessage}`,
                        sound: '',
                        priority: -1,
                        title: 'Backitup',
                        device: options.pushover.deviceID,
                    });
                } else {
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

export const ignoreErrors = true;
export const afterBackup = true;
