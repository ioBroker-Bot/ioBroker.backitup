"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.afterBackup = exports.ignoreErrors = void 0;
exports.command = command;
const notificationText_1 = require("../notificationText");
function command(options, log, callback) {
    setTimeout(() => {
        if (options.adapter) {
            const errors = Object.keys(options.context.errors);
            if (errors.length) {
                // Same text the notification channels send. It used to be a verbatim copy of that
                // block here, including the Grafana masking bug that let the API key through.
                const errorMessage = (0, notificationText_1.buildErrorMessage)(options, options.notification.systemLang);
                log.debug('Admin notification will be sent');
                // Not awaited in the original either; `void` only marks that for the linter.
                void options.adapter.registerNotification('backitup', 'backupError', errorMessage);
            }
        }
        callback?.();
    }, 1000);
}
exports.ignoreErrors = true;
exports.afterBackup = true;
//# sourceMappingURL=99-notification.js.map