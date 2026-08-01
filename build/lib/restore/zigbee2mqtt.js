"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStop = void 0;
exports.restore = restore;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const fs_extra_1 = require("fs-extra");
const targz_1 = require("../targz");
async function restore(options, fileName, log, _adapter, callback) {
    let cb = callback;
    log.debug('Start Zigbee2MQTT Restore ...');
    const timer = setInterval(() => {
        if ((0, node_fs_1.existsSync)(options.path)) {
            log.debug('Extracting Zigbee2MQTT Backup file...');
        }
        else {
            log.debug('Something is wrong. No file found.');
        }
    }, 10000);
    const destPth = (0, node_path_1.join)(options.path).replace(/\\/g, '/');
    const tmpDir = (0, node_path_1.join)(options.backupDir, 'zigbee2mqtt_tmp').replace(/\\/g, '/');
    try {
        await (0, fs_extra_1.ensureDir)(tmpDir);
        log.debug(`Zigbee2MQTT tmp directory created: ${tmpDir}`);
    }
    catch {
        log.debug('Zigbee2MQTT tmp directory cannot created');
    }
    try {
        (0, targz_1.decompress)({
            src: fileName,
            dest: tmpDir,
        }, 
        // lib/targz only ever passes an error, so the `stderr` the original forwarded as the
        // exit code was always undefined.
        async (err) => {
            if (timer) {
                clearInterval(timer);
            }
            if (err) {
                log.error(err);
                if (cb) {
                    log.error('Zigbee2MQTT Restore not completed');
                    cb(err);
                    cb = undefined;
                }
            }
            else {
                if (cb) {
                    // Restore Backup-Files
                    if ((0, node_fs_1.existsSync)(tmpDir) && (0, node_fs_1.existsSync)(destPth)) {
                        const files = (0, node_fs_1.readdirSync)(destPth);
                        // NOTE: `file` is a bare name, so this deletes relative to the process
                        // working directory rather than from `destPth` - and the callback is
                        // async inside forEach, so nothing waits for it either. Kept as found.
                        files.forEach(async (file) => {
                            const stat = (0, node_fs_1.statSync)((0, node_path_1.join)(destPth, file));
                            if (!stat.isDirectory()) {
                                await (0, fs_extra_1.remove)(file);
                            }
                        });
                        await (0, fs_extra_1.copy)(tmpDir, destPth, {
                            filter: (path) => !path.includes('log'),
                        })
                            .then(async () => {
                            log.debug('Zigbee2MQTT copy finish');
                            log.debug('Try deleting the Zigbee2MQTT tmp directory');
                            await (0, fs_extra_1.remove)(tmpDir);
                            if (!(0, node_fs_1.existsSync)(tmpDir)) {
                                log.debug('Zigbee2MQTT tmp directory was successfully deleted');
                            }
                            log.debug('Zigbee2MQTT Restore completed successfully');
                            cb(null, 'Zigbee2MQTT restore done');
                            cb = undefined;
                        })
                            .catch(err => {
                            log.error(err);
                            cb?.(null, 'Zigbee2MQTT restore broken');
                            cb = undefined;
                        });
                    }
                    else {
                        log.debug('Zigbee2MQTT Restore not completed. Please check your Path Configuration.');
                        cb(null, 'Zigbee2MQTT Restore not completed');
                        cb = undefined;
                    }
                }
            }
        });
    }
    catch (e) {
        if (cb) {
            cb(e);
            cb = undefined;
        }
    }
}
exports.isStop = false;
//# sourceMappingURL=zigbee2mqtt.js.map