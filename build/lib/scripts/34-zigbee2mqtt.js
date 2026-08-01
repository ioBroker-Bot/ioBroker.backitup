"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const fs_extra_1 = require("fs-extra");
const tools_1 = require("../tools");
const targz_1 = require("../targz");
async function command(options, log, callback) {
    let cb = callback;
    const nameSuffix = options.hostType === 'Slave' && options.slaveSuffix
        ? options.slaveSuffix
        : options.hostType !== 'Slave' && options.nameSuffix
            ? options.nameSuffix
            : '';
    if (options.z2mType === 'remote') {
        // Loaded on demand - hoisting this would pull the whole MQTT stack into every adapter
        // start, including the instances that only back up a local Zigbee2MQTT directory.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mqtt = require('mqtt');
        const fileName = (0, node_path_1.join)(options.backupDir, `zigbee2mqtt_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backup.zip`);
        options.context.fileNames.push(fileName);
        const z2mOptions = {};
        if (options.z2mUsername) {
            z2mOptions.username = options.z2mUsername;
        }
        if (options.z2mPassword) {
            z2mOptions.password = options.z2mPassword;
        }
        const client = mqtt.connect(`mqtt://${options.z2mUrl}:${options.z2mPort}`, z2mOptions);
        let timeout;
        // Note: the timer runs for 60s while the message says 30s. Kept as found.
        function resetTimeout() {
            if (timeout) {
                clearTimeout(timeout);
            }
            timeout = setTimeout(() => {
                log.error('Timeout: No response from Zigbee2MQTT (in 30s)');
                client.end();
                // Not cleared afterwards, so a late message or error still reports again.
                cb?.(new Error('Timeout waiting for Zigbee2MQTT response'));
            }, 60000);
        }
        client.on('connect', () => {
            log.debug('Connected to MQTT broker, sending Zigbee2MQTT backup request...');
            client.subscribe(`${options.z2mBaseTopic}/bridge/response/backup`, err => {
                if (err) {
                    log.error('Failed to subscribe to Zigbee2MQTT response topic');
                    client.end();
                    cb?.(err);
                    return;
                }
                client.publish(`${options.z2mBaseTopic}/bridge/request/backup`, '');
                resetTimeout();
            });
        });
        client.on('message', (topic, message) => {
            if (topic !== `${options.z2mBaseTopic}/bridge/response/backup`) {
                return;
            }
            resetTimeout();
            try {
                const response = JSON.parse(message.toString());
                log.debug('Received Zigbee2MQTT response');
                const base64Data = response?.data?.zip;
                if (!base64Data) {
                    throw new Error(`Missing "zip" field in response: ${JSON.stringify(response)}`);
                }
                const buffer = Buffer.from(base64Data, 'base64');
                (0, node_fs_1.writeFileSync)(fileName, buffer);
                log.debug(`Zigbee2MQTT backup saved to ${fileName}`);
                options.context.done.push('zigbee2mqtt');
                options.context.types.push('zigbee2mqtt');
                clearTimeout(timeout);
                client.end();
                cb?.(null);
            }
            catch (err) {
                clearTimeout(timeout);
                log.error(`Error parsing backup response: ${err.message}`);
                options.context.errors.zigbee2mqtt = err.toString();
                client.end();
                cb?.(err);
            }
        });
        client.on('error', err => {
            clearTimeout(timeout);
            log.error(`MQTT error: ${err.message}`);
            options.context.errors.zigbee2mqtt = err.toString();
            client.end();
            cb?.(err);
        });
    }
    else {
        const fileName = (0, node_path_1.join)(options.backupDir, `zigbee2mqtt_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`);
        const sourcePth = (0, node_path_1.join)(options.path).replace(/\\/g, '/');
        const tmpDir = (0, node_path_1.join)(options.backupDir, 'zigbee2mqtt_tmp').replace(/\\/g, '/');
        options.context.fileNames.push(fileName);
        const timer = setInterval(() => {
            if ((0, node_fs_1.existsSync)(fileName)) {
                const stats = (0, node_fs_1.statSync)(fileName);
                const fileSize = Math.floor(stats.size / (1024 * 1024));
                log.debug(`Packed ${fileSize}MB so far...`);
            }
        }, 10000);
        // Stays undefined when the configured source does not exist; `tmpCopy` then fails and the
        // catch below turns that into the reported error. Kept as found.
        let pth;
        if ((0, node_fs_1.existsSync)(sourcePth)) {
            const stat = (0, node_fs_1.statSync)(sourcePth);
            if (!stat.isDirectory()) {
                // Splitting and re-joining on '/' yields the input again - the original intent was
                // presumably to strip the file name. Kept as found.
                const parts = sourcePth.replace(/\\/g, '/').split('/');
                pth = parts.join('/');
            }
            else {
                pth = sourcePth;
            }
        }
        const desiredMode = {
            mode: 0o2775,
        };
        if (!(0, node_fs_1.existsSync)(tmpDir)) {
            try {
                await (0, fs_extra_1.ensureDir)(tmpDir, desiredMode);
                log.debug('Created zigbee2mqtt directory');
            }
            catch {
                log.error(`zigbee2mqtt tmp directory "${tmpDir}" cannot created`);
            }
        }
        else {
            log.debug(`Try deleting the old zigbee2mqtt tmp directory: "${tmpDir}"`);
            try {
                await (0, fs_extra_1.remove)(tmpDir);
            }
            catch {
                log.error(`old zigbee2mqtt tmp directory "${tmpDir}" cannot deleted`);
            }
            if (!(0, node_fs_1.existsSync)(tmpDir)) {
                log.debug(`old zigbee2mqtt tmp directory "${tmpDir}" successfully deleted`);
                try {
                    await (0, fs_extra_1.ensureDir)(tmpDir, desiredMode);
                    log.debug('Created new zigbee2mqtt directory');
                }
                catch {
                    log.error(`zigbee2mqtt tmp directory "${tmpDir}" cannot created`);
                }
            }
        }
        log.debug('compress from Zigbee2MQTT started ...');
        try {
            await tmpCopy(pth, tmpDir, log);
            await compressBackupFile(options, fileName, tmpDir, log, cb);
        }
        catch (err) {
            clearInterval(timer);
            // NOTE: `compressBackupFile` rejects without a reason, so on a packing failure `err` is
            // undefined here and this line throws a TypeError out of `command` - an unhandled
            // rejection that also skips the cleanup and the `done` entry below. The callback has
            // already reported the packing error at that point. Kept as found.
            options.context.errors.zigbee2mqtt = err.toString();
            log.error(err);
            try {
                await delTmp(options, tmpDir, log);
            }
            catch {
                log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
            }
            if (cb) {
                cb(null);
                cb = undefined;
            }
        }
        // Reached after a copy failure too - reported as done and cleaned up a second time.
        clearInterval(timer);
        options.context.done.push('zigbee2mqtt');
        options.context.types.push('zigbee2mqtt');
        try {
            await delTmp(options, tmpDir, log);
        }
        catch {
            log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
        }
        if (cb) {
            cb(null);
            cb = undefined;
        }
    }
}
/**
 * Removes the temporary copy directory, rejecting when it cannot be deleted.
 *
 * @param options script options, for the error store
 * @param tmpDir directory to remove
 * @param log adapter logger
 */
async function delTmp(options, tmpDir, log) {
    log.debug(`Try deleting the old zigbee2mqtt tmp directory: "${tmpDir}"`);
    return (0, fs_extra_1.remove)(tmpDir)
        .then(() => {
        if (!(0, node_fs_1.existsSync)(tmpDir)) {
            log.debug(`zigbee2mqtt tmp directory "${tmpDir}" successfully deleted`);
        }
    })
        .catch(err => {
        options.context.errors.zigbee2mqtt = JSON.stringify(err);
        log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
        throw err;
    });
}
/**
 * Copies the Zigbee2MQTT data directory into the staging directory, skipping log files.
 *
 * @param pth source directory
 * @param tmpDir staging directory
 * @param log adapter logger
 */
async function tmpCopy(pth, tmpDir, log) {
    return (0, fs_extra_1.copy)(pth, tmpDir, {
        // Matches anywhere in the path, so a backup directory containing "log" excludes
        // everything. Kept as found.
        filter: (path) => !(path.indexOf('log') > -1),
    }).then(() => {
        log.debug('Zigbee2MQTT tmp copy finish');
    });
}
/**
 * Packs the staging directory.
 *
 * Reports a packing failure through the callback and then rejects **without a reason** - see the
 * note at the call site.
 *
 * @param options script options, for the error store
 * @param fileName archive to write
 * @param tmpDir staging directory to pack
 * @param log adapter logger
 * @param callback reports the packing failure
 */
async function compressBackupFile(options, fileName, tmpDir, log, callback) {
    return new Promise((resolve, reject) => {
        let cb = callback;
        (0, targz_1.compress)({
            src: tmpDir,
            dest: fileName,
        }, 
        // lib/targz only ever passes an error; the `stderr` parameter the original declared
        // here was always undefined, so its `log.error(stderr)` never fired.
        err => {
            if (err) {
                options.context.errors.zigbee2mqtt = err.toString();
                if (cb) {
                    cb(err);
                    cb = undefined;
                    // Without a callback this never settles and `command` hangs. Kept as found.
                    reject();
                }
            }
            else {
                log.debug(`Backup created: ${fileName}`);
                resolve();
            }
        });
    });
}
exports.ignoreErrors = true;
//# sourceMappingURL=34-zigbee2mqtt.js.map