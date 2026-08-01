import { _ } from '../tools';
import { buildErrorMessage, buildStorageList, type NotificationOptions } from '../notificationText';
import type { BackItUpScriptCallback } from './types';

interface SignalOptions extends NotificationOptions {
    name: string;
    debugging?: boolean;
    adapter: ioBroker.Adapter;
    signal: {
        enabled?: boolean;
        instance?: string | null;
        systemLang: string;
        time?: string;
        hostName?: string;
        onlyError?: boolean;
        NoticeType?: 'longSignalNotice' | 'shortSignalNotice';
        signalWaiting?: number;
    };
}

export function command(options: SignalOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    setTimeout(() => {
        if (
            options.signal.enabled &&
            options.adapter &&
            options.signal.instance !== '' &&
            options.signal.instance !== null &&
            options.signal.instance !== undefined
        ) {
            // Send signal Message
            if (options.debugging) {
                log.debug(`[${options.name}] used Signal-Instance: ${options.signal.instance}`);
            }

            // analyse here the info from options.context.errors and options.context.done
            const errors = Object.keys(options.context.errors);

            if (!errors.length) {
                let messageText = `${_('New %e Backup created on %t', options.signal.systemLang)}.`;
                messageText = messageText
                    .replace('%t', options.signal.time as string)
                    .replace(
                        '%e',
                        `${options.name}${options.name === 'iobroker' && options.signal.hostName ? ` (${options.signal.hostName})` : ''}`,
                    );

                if (options.signal?.NoticeType === 'longSignalNotice') {
                    messageText += buildStorageList(options, options.signal.systemLang);
                }

                // The `=== 'false'` arm covers instance configurations that stored the flag as a string.
                if (options.signal.onlyError === false || (options.signal.onlyError as unknown) === 'false') {
                    options.adapter.sendTo(options.signal.instance, 'send', {
                        text: `Backitup:\n${messageText}`,
                    });
                }
            } else {
                const errorMessage = buildErrorMessage(options, options.signal.systemLang);

                options.adapter.sendTo(options.signal.instance, 'send', {
                    text: `Backitup:\n${errorMessage}`,
                });
            }
        }
        callback?.();
    }, options.signal.signalWaiting);
}

export const ignoreErrors = true;
export const afterBackup = true;
