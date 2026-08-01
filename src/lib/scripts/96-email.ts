import { _ } from '../tools';
import { buildErrorMessage, buildStorageList, type NotificationOptions } from '../notificationText';
import type { BackItUpScriptCallback } from './types';

interface EmailOptions extends NotificationOptions {
    name: string;
    debugging?: boolean;
    adapter: ioBroker.Adapter;
    email: {
        enabled?: boolean;
        instance?: string | null;
        systemLang: string;
        time?: string;
        hostName?: string;
        emailReceiver?: string;
        emailSender?: string;
        onlyError?: boolean;
        NoticeType?: 'longEmailNotice' | 'shortEmailNotice';
        emailWaiting?: number;
    };
}

export function command(options: EmailOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    setTimeout(() => {
        if (
            options.email.enabled &&
            options.adapter &&
            options.email.instance !== '' &&
            options.email.instance !== null &&
            options.email.instance !== undefined
        ) {
            // Send E-Mail Message
            if (options.debugging) {
                log.debug(`[${options.name}] used E-Mail-Instance: ${options.email.instance}`);
            }

            // analyse here the info from options.context.errors and options.context.done
            const errors = Object.keys(options.context.errors);

            if (!errors.length) {
                let messageText = `${_('New %e Backup created on %t', options.email.systemLang)}.`;
                messageText = messageText
                    .replace('%t', options.email.time as string)
                    .replace(
                        '%e',
                        `${options.name}${options.name === 'iobroker' && options.email.hostName ? ` (${options.email.hostName})` : ''}`,
                    );

                if (options.email?.NoticeType === 'longEmailNotice') {
                    messageText += buildStorageList(options, options.email.systemLang);
                }

                // The `=== 'false'` arm covers instance configurations that stored the flag as a string.
                if (options.email.onlyError === false || (options.email.onlyError as unknown) === 'false') {
                    options.adapter.sendTo(options.email.instance, 'send', {
                        text: `Backitup:\n${messageText}`,
                        to: options.email.emailReceiver,
                        subject: 'Backitup',
                        from: options.email.emailSender,
                    });
                }
            } else {
                const errorMessage = buildErrorMessage(options, options.email.systemLang);

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

export const ignoreErrors = true;
export const afterBackup = true;
