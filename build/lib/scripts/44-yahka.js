"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const tools_1 = require("../tools");
const targz_1 = require("../targz");
function command(options, log, callback) {
    const yahkaInst = [];
    let cb = callback;
    // Instances are probed by index; the run reports back once index 100 is reached without a
    // matching directory. Should a `yahka.100.hapdata` ever exist the callback is never invoked -
    // kept as found.
    for (let i = 0; i <= 100; i++) {
        const pth = (0, node_path_1.join)(options.path, `yahka.${i}.hapdata`);
        if ((0, node_fs_1.existsSync)(pth)) {
            let nameSuffix;
            if (options.hostType === 'Slave') {
                nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
            }
            else {
                nameSuffix = options.nameSuffix ? options.nameSuffix : '';
            }
            const fileName = (0, node_path_1.join)(options.backupDir, `yahka.${i}_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`);
            options.context.fileNames.push(fileName);
            (0, targz_1.compress)({
                src: pth,
                dest: fileName,
            }, 
            // lib/targz only ever passes an error; the second parameter the original declared
            // here was always undefined.
            err => {
                if (err) {
                    options.context.errors.yahka = err.toString();
                    if (cb) {
                        cb(err);
                        cb = undefined;
                    }
                }
                else {
                    options.context.types.push(`yahka.${i}`);
                    options.context.done.push(`yahka.${i}`);
                }
            });
            yahkaInst.push(`yahka.${i}`);
            if (i === 100) {
                if (yahkaInst.length) {
                    log.debug(`found yahka database: ${yahkaInst.join(',')}`);
                }
                else {
                    log.warn('no yahka database found!!');
                }
            }
        }
        else if (!(0, node_fs_1.existsSync)(pth) && i === 100) {
            if (yahkaInst.length) {
                log.debug(`found yahka database: ${yahkaInst.join(',')}`);
            }
            else {
                log.warn('no yahka database found!!');
            }
            cb?.(null, 'done');
            break;
        }
    }
}
exports.ignoreErrors = true;
//# sourceMappingURL=44-yahka.js.map