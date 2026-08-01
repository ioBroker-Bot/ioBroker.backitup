"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStop = void 0;
exports.restore = restore;
const node_child_process_1 = require("node:child_process");
const js_controller_common_1 = require("@iobroker/js-controller-common");
function restore(_options, fileName, log, callback) {
    let cb = callback;
    const ioPath = `${js_controller_common_1.tools.getControllerDir()}/iobroker.js`;
    try {
        log.debug(`Start ioBroker Restore from "${fileName}"...`);
        log.debug(ioPath);
        const cmd = (0, node_child_process_1.fork)(ioPath, ['restore', fileName, '--force'], { silent: true });
        cmd.stdout.on('data', data => log.debug(data.toString()));
        cmd.stderr.on('data', data => log.error(data.toString()));
        cmd.on('close', code => {
            if (cb) {
                // Logged as a success regardless of the exit code; the code itself is passed on.
                log.debug('ioBroker Restore completed successfully');
                cb(null, code);
                cb = undefined;
            }
        });
        cmd.on('error', error => {
            log.error(error);
            if (cb) {
                cb(error, -1);
                cb = undefined;
            }
        });
    }
    catch (error) {
        log.error('ioBroker Restore not completed');
        log.error(error);
        if (cb) {
            cb(error, -1);
            cb = undefined;
        }
    }
}
exports.isStop = true;
//# sourceMappingURL=iobroker.js.map