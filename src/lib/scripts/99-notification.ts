import { buildErrorMessage, type NotificationOptions } from '../notificationText';
import type { BackItUpScriptCallback } from './types';

interface AdminNotificationOptions extends NotificationOptions {
    adapter: ioBroker.Adapter;
    notification: {
        systemLang: string;
    };
}

export function command(
    options: AdminNotificationOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): void {
    setTimeout(() => {
        if (options.adapter) {
            const errors = Object.keys(options.context.errors);

            if (errors.length) {
                // Same text the notification channels send. It used to be a verbatim copy of that
                // block here, including the Grafana masking bug that let the API key through.
                const errorMessage = buildErrorMessage(options, options.notification.systemLang);

                log.debug('Admin notification will be sent');
                // Not awaited in the original either; `void` only marks that for the linter.
                void options.adapter.registerNotification('backitup', 'backupError', errorMessage);
            }
        }
        callback?.();
    }, 1000);
}

export const ignoreErrors = true;
export const afterBackup = true;
