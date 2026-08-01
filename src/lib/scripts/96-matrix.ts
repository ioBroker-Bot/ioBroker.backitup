import { _ } from '../tools';
import { buildErrorMessage, buildStorageList, type NotificationOptions } from '../notificationText';
import type { BackItUpScriptCallback } from './types';

interface MatrixOptions extends NotificationOptions {
    name: string;
    debugging?: boolean;
    adapter: ioBroker.Adapter;
    matrix: {
        enabled?: boolean;
        instance?: string | null;
        systemLang: string;
        time?: string;
        hostName?: string;
        onlyError?: boolean;
        NoticeType?: 'longMatrixNotice' | 'shortMatrixNotice';
        matrixWaiting?: number;
    };
}

export function command(options: MatrixOptions, log: ioBroker.Logger, callback?: BackItUpScriptCallback): void {
    setTimeout(() => {
        if (
            options.matrix.enabled &&
            options.adapter &&
            options.matrix.instance !== '' &&
            options.matrix.instance !== null &&
            options.matrix.instance !== undefined
        ) {
            // Send matrix Message
            if (options.debugging) {
                log.debug(`[${options.name}] used Matrix-Instance: ${options.matrix.instance}`);
            }

            // analyse here the info from options.context.errors and options.context.done
            const errors = Object.keys(options.context.errors);

            if (!errors.length) {
                let messageText = `${_('New %e Backup created on %t', options.matrix.systemLang)}.`;
                messageText = messageText
                    .replace('%t', options.matrix.time as string)
                    .replace(
                        '%e',
                        `${options.name}${options.name === 'iobroker' && options.matrix.hostName ? ` (${options.matrix.hostName})` : ''}`,
                    );

                if (options.matrix?.NoticeType === 'longMatrixNotice') {
                    messageText += buildStorageList(options, options.matrix.systemLang);
                }

                // The `=== 'false'` arm covers instance configurations that stored the flag as a string.
                if (options.matrix.onlyError === false || (options.matrix.onlyError as unknown) === 'false') {
                    // Note the stray apostrophe after the newline and the two-argument sendTo -
                    // both as in the original.
                    options.adapter.sendTo(options.matrix.instance, {
                        html: `Backitup:\n'${messageText}`,
                        text: `Backitup:\n'${messageText}`,
                    });
                }
            } else {
                const errorMessage = buildErrorMessage(options, options.matrix.systemLang);

                // "BackItUp" is spelled differently here than in the success case - kept as found.
                options.adapter.sendTo(options.matrix.instance, {
                    html: `BackItUp:\n'${errorMessage}`,
                    text: `BackItUp:\n'${errorMessage}`,
                });
            }
        }
        callback?.();
    }, options.matrix.matrixWaiting);
}

export const ignoreErrors = true;
export const afterBackup = true;
