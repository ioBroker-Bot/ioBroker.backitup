"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const tools_1 = require("../tools");
const targz_1 = require("../targz");
function command(options, log, callback) {
    let nameSuffix;
    if (options.hostType === 'Slave') {
        nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
    }
    else {
        nameSuffix = options.nameSuffix ? options.nameSuffix : '';
    }
    const fileName = (0, node_path_1.join)(options.backupDir, `historyDB_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`);
    const sourcePth = (0, node_path_1.join)(options.path).replace(/\\/g, '/');
    options.context.fileNames.push(fileName);
    const timer = setInterval(() => {
        if ((0, node_fs_1.existsSync)(fileName)) {
            const stats = (0, node_fs_1.statSync)(fileName);
            const fileSize = Math.floor(stats.size / (1024 * 1024));
            log.debug(`Packed ${fileSize}MB so far...`);
        }
    }, 10000);
    let name;
    let pth;
    if ((0, node_fs_1.existsSync)(sourcePth)) {
        const stat = (0, node_fs_1.statSync)(sourcePth);
        if (!stat.isDirectory()) {
            // A single file: pack its directory and filter down to that one entry.
            const parts = sourcePth.replace(/\\/g, '/').split('/');
            name = parts.pop();
            pth = parts.join('/');
        }
        else {
            pth = sourcePth;
        }
    }
    log.debug('compress from historyDB started ...');
    let cb = callback;
    (0, targz_1.compress)({
        src: pth,
        dest: fileName,
        tar: {
            ignore: nm => !!name && name !== nm.replace(/\\/g, '/').split('/').pop(),
        },
    }, 
    // lib/targz only ever passes an error; the stdout/stderr parameters the original declared
    // here were always undefined, so the `stderr && log.error(stderr)` line never ran.
    err => {
        clearInterval(timer);
        if (err) {
            options.context.errors.historyDB = err.toString();
            if (cb) {
                cb(err);
                cb = undefined;
            }
        }
        else {
            log.debug(`Backup created: ${fileName}`);
            options.context.done.push('historyDB');
            options.context.types.push('historyDB');
            if (cb) {
                cb(null);
                cb = undefined;
            }
        }
    });
}
exports.ignoreErrors = true;
//# sourceMappingURL=34-historyDB.js.map