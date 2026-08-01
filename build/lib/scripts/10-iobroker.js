"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const tools_1 = require("../tools");
/** Warn above this archive size, in megabytes */
const SIZE_WARNING_MB = 500;
function command(options, log, callback) {
    let cb = callback;
    if (options.workDir != undefined) {
        const ioPath = options.workDir;
        try {
            const fileName = (0, node_path_1.join)(options.backupDir, `iobroker_${(0, tools_1.getDate)()}${options.nameSuffix ? `_${options.nameSuffix}` : ''}_backupiobroker.tar.gz`);
            options.context.fileNames.push(fileName);
            const cmd = (0, node_child_process_1.fork)(ioPath, ['backup', fileName], { silent: true });
            cmd.stdout.on('data', data => log.debug(data.toString()));
            cmd.stderr.on('data', data => log.error(data.toString()));
            cmd.on('close', code => {
                // Recorded as done regardless of the exit code; a missing file is what marks the
                // failure below. Kept as found.
                options.context.done.push('iobroker');
                options.context.types.push('iobroker');
                if ((0, node_fs_1.existsSync)(fileName)) {
                    const stat = (0, node_fs_1.statSync)(fileName);
                    if (Math.round((stat.size / (1024 * 1024)) * 10) / 10 > SIZE_WARNING_MB) {
                        log.warn(`Your backup ${fileName.split('/').pop()} has a file size of ${(0, tools_1.getSize)(stat.size)}. This can lead to problems. Please check your file system for large files.`);
                    }
                }
                else {
                    options.context.errors.iobroker = 'ioBroker Backup not created';
                }
                if (cb) {
                    cb(null, null, code);
                    cb = undefined;
                }
            });
            cmd.on('error', error => {
                options.context.errors.iobroker = error;
                console.error(`error: ${error}`);
                if (cb) {
                    cb(error, null, -1);
                    cb = undefined;
                }
            });
        }
        catch (error) {
            options.context.errors.iobroker = error;
            if (cb) {
                cb(error, null, -1);
                cb = undefined;
            }
        }
    }
    else {
        options.context.errors.iobroker = 'Unable to read iobroker path';
        log.error('Unable to read iobroker path');
        if (cb) {
            cb(null, null, -1);
            cb = undefined;
        }
    }
}
exports.ignoreErrors = false;
//# sourceMappingURL=10-iobroker.js.map