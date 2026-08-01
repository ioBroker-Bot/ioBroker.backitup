"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const tools_1 = require("../tools");
const targz_1 = require("../targz");
async function command(options, log, callback) {
    const zigbeeInst = [];
    let cb = callback;
    try {
        for (let i = 0; i <= 10; i++) {
            // Check if zigbee adapter instance exists
            const obj = await options.adapter.getForeignObjectAsync(`system.adapter.zigbee.${i}`);
            if (!obj) {
                continue;
            }
            // Check if corresponding folder exists
            const pth = (0, node_path_1.join)(options.path, `zigbee_${i}`);
            if (!(0, node_fs_1.existsSync)(pth)) {
                continue;
            }
            // Determine suffix for the filename
            let nameSuffix = '';
            if (options.hostType === 'Slave') {
                nameSuffix = options.slaveSuffix || '';
            }
            else {
                nameSuffix = options.nameSuffix || '';
            }
            // Construct backup filename
            const fileName = (0, node_path_1.join)(options.backupDir, `zigbee.${i}_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`);
            options.context.fileNames.push(fileName);
            // Run compression and wait for it to finish
            await new Promise(resolve => {
                (0, targz_1.compress)({
                    src: pth,
                    dest: fileName,
                    tar: {
                        ignore: name => (0, node_path_1.extname)(name) === '.gz',
                    },
                }, 
                // lib/targz only ever passes an error; the stdout/stderr parameters the original
                // declared here were always undefined.
                err => {
                    if (err) {
                        options.context.errors.zigbee = err.toString();
                        if (cb) {
                            cb(err);
                            cb = undefined;
                        }
                    }
                    else {
                        options.context.types.push(`zigbee.${i}`);
                        options.context.done.push(`zigbee.${i}`);
                    }
                    resolve();
                });
            });
            zigbeeInst.push(`zigbee.${i}`);
        }
        // Log summary
        if (zigbeeInst.length) {
            log.debug(`Found zigbee databases: ${zigbeeInst.join(', ')}`);
        }
        else {
            log.warn('No zigbee databases found!');
        }
        // Final callback
        cb?.(null, 'done');
    }
    catch (err) {
        log.error(`Error during zigbee backup: ${err.message}`);
        cb?.(err);
    }
}
exports.ignoreErrors = true;
//# sourceMappingURL=34-zigbee.js.map