"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStop = void 0;
exports.restore = restore;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const fs_extra_1 = require("fs-extra");
const targz_1 = require("../targz");
const tools_1 = require("../tools");
/**
 * Runs the influx restore command against the unpacked dump.
 *
 * @param options connection settings; in multi mode these are re-pointed at the matching target
 * @param tmpDir directory the backup was unpacked into
 * @param log restore logger
 * @param callback reports the command exit status
 */
function replayInfluxDB(options, tmpDir, log, callback) {
    let dbName = options.dbName;
    if (options.influxDBMulti === true && (0, node_fs_1.existsSync)(tmpDir)) {
        const files = (0, node_fs_1.readdirSync)(tmpDir);
        try {
            files.forEach(function (file) {
                const currentFiletype = file.split('.').pop();
                if (currentFiletype === 'manifest') {
                    const manifest = (0, node_fs_1.readFileSync)((0, node_path_1.join)(tmpDir, file).replace(/\\/g, '/'));
                    const json = JSON.parse(manifest.toString());
                    options.dbversion = json.files ? '1.x' : json.buckets ? '2.x' : options.dbversion;
                    dbName =
                        options.dbversion === '1.x'
                            ? json.files[0].database
                            : options.dbversion === '2.x'
                                ? json.buckets[0].bucketName
                                : options.dbName;
                }
            });
        }
        catch (err) {
            log.error(`manifest is broken: ${err}`);
        }
        try {
            for (let i = 0; i < options.influxDBEvents.length; i++) {
                if (options.influxDBEvents[i].dbName === dbName) {
                    options.port = options.influxDBEvents[i].port ? options.influxDBEvents[i].port : '';
                    options.host = options.influxDBEvents[i].host ? options.influxDBEvents[i].host : '';
                    options.dbName = options.influxDBEvents[i].dbName ? options.influxDBEvents[i].dbName : '';
                    options.nameSuffix = options.influxDBEvents[i].nameSuffix
                        ? options.influxDBEvents[i].nameSuffix
                        : '';
                    options.token = options.influxDBEvents[i].token ? options.influxDBEvents[i].token : '';
                    options.dbversion = options.influxDBEvents[i].dbversion
                        ? options.influxDBEvents[i].dbversion
                        : '';
                    options.protocol = options.influxDBEvents[i].protocol
                        ? options.influxDBEvents[i].protocol
                        : '';
                }
            }
        }
        catch (err) {
            log.error(`InfluxDB config not found: ${err}`);
        }
    }
    const cmdDelete = `influx -execute='DROP DATABASE ${dbName}'`;
    // Stays undefined for any other version, and `exec(undefined)` then throws into the catch
    // below. Kept as found.
    let cmd;
    if (options.dbversion === '1.x') {
        cmd = `${options.exe ? `"${options.exe}"` : 'influxd'} restore -portable -db ${dbName}${options.dbType === 'remote' ? ` -host ${options.host}:${options.port}` : ''} "${tmpDir}"`;
    }
    else if (options.dbversion === '2.x') {
        // As in lib/scripts/12-influxDB the access token goes onto the command line.
        cmd = `${options.exe ? `"${options.exe}"` : 'influx'} restore --bucket ${dbName}${options.dbType === 'remote' ? ` --host ${options.protocol}://${options.host}:${options.port}` : ''} -t ${options.token} "${tmpDir}"`;
    }
    if (options.deleteDatabase && options.dbType === 'local') {
        try {
            (0, node_child_process_1.exec)(cmdDelete, (error, stdout) => {
                log.debug(stdout);
                // The original kept the ChildProcess in an unused `child` binding.
                (0, node_child_process_1.exec)(cmd, (error, stdout, stderr) => {
                    if (error) {
                        // The 2.x command line carries the access token and `error.message` starts
                        // with "Command failed: <command>". The caller currently drops this error,
                        // so nothing leaks today - scrubbed anyway so it stays safe if it is ever
                        // logged or reported. See lib/scripts/12-influxDB, where it did leak.
                        error.message = (0, tools_1.maskSecret)(error.message, options.token);
                        log.error(stderr);
                    }
                    callback?.(error);
                });
            });
        }
        catch (e) {
            callback?.(e);
        }
    }
    else {
        try {
            // The original kept the ChildProcess in an unused `child` binding.
            (0, node_child_process_1.exec)(cmd, (error, stdout, stderr) => {
                if (error) {
                    // Same scrubbing as in the branch above.
                    error.message = (0, tools_1.maskSecret)(error.message, options.token);
                    log.error(stderr);
                }
                callback?.(error);
            });
        }
        catch (e) {
            callback?.(e);
        }
    }
}
function restore(options, fileName, log, adapter, callback) {
    let cb = callback;
    const tmpDir = (0, node_path_1.join)(options.backupDir, 'influxDBtmp').replace(/\\/g, '/');
    // stop influxdb-Adapter before Restore
    let startAfterRestore = false;
    const enabledInstances = [];
    // Not awaited, so the instances may still be stopping when the replay starts. Kept as found.
    void adapter.getObjectView('system', 'instance', { startkey: 'system.adapter.influxdb.', endkey: 'system.adapter.influxdb.\u9999' }, (err, instances) => {
        const resultInstances = [];
        if (!err && instances && instances.rows) {
            instances.rows.forEach(row => resultInstances.push({
                id: row.id.replace('system.adapter.', ''),
                config: row.value.native.type,
            }));
            for (let i = 0; i < resultInstances.length; i++) {
                const _id = resultInstances[i].id;
                // Stop influxdb Instances
                void adapter.getForeignObject(`system.adapter.${_id}`, (err, obj) => {
                    if (obj?.common?.enabled) {
                        void adapter.setForeignState(`system.adapter.${_id}.alive`, false);
                        log.debug(`${_id} is stopped`);
                        enabledInstances.push(_id);
                        startAfterRestore = true;
                    }
                });
            }
        }
        else {
            log.debug('Could not retrieve influxdb instances!');
        }
    });
    // A string, so fs-extra reads no mode from it and falls back to the default. Kept as found.
    const desiredMode = '0o2775';
    if (!(0, node_fs_1.existsSync)(tmpDir)) {
        (0, fs_extra_1.ensureDirSync)(tmpDir, desiredMode);
        log.debug('Created tmp directory');
    }
    else {
        try {
            log.debug('Try deleting the old InfluxDB tmp directory');
            (0, fs_extra_1.removeSync)(tmpDir);
            if (!(0, node_fs_1.existsSync)(tmpDir)) {
                log.debug('InfluxDB old tmp directory was successfully deleted');
            }
            (0, fs_extra_1.ensureDirSync)(tmpDir, desiredMode);
            log.debug('Created tmp directory');
        }
        catch (e) {
            log.debug(`InfluxDB old tmp directory could not be deleted: ${e}`);
        }
    }
    log.debug('Start influxDB Restore ...');
    try {
        (0, targz_1.decompress)({
            src: fileName,
            dest: tmpDir,
        }, 
        // lib/targz only ever passes an error, so the `stderr` the original forwarded as the
        // exit code was always undefined.
        err => {
            if (err) {
                log.error(err);
                if (cb) {
                    log.error('influxDB Restore not completed');
                    cb(err);
                    cb = undefined;
                }
            }
            else {
                if (cb) {
                    // The replay error is deliberately ignored - the step always reports success.
                    replayInfluxDB(options, tmpDir, log, () => {
                        // Start influxDB Instances
                        if (startAfterRestore) {
                            enabledInstances.forEach(enabledInstance => {
                                void adapter.getForeignObject(`system.adapter.${enabledInstance}`, (err, obj) => {
                                    if (obj && !obj.common?.enabled) {
                                        void adapter.setForeignState(`system.adapter.${enabledInstance}.alive`, true);
                                        log.debug(`${enabledInstance} started`);
                                    }
                                });
                            });
                        }
                        // delete influxDB tmpDir
                        if ((0, node_fs_1.existsSync)(tmpDir)) {
                            try {
                                log.debug('Try deleting the InfluxDB tmp directory');
                                (0, fs_extra_1.removeSync)(tmpDir);
                                if (!(0, node_fs_1.existsSync)(tmpDir)) {
                                    log.debug('InfluxDB tmp directory was successfully deleted');
                                }
                            }
                            catch (e) {
                                log.debug(`InfluxDB tmp directory could not be deleted: ${e}`);
                            }
                        }
                        log.debug('influxDB Restore completed successfully');
                        cb?.(null, 'influxDB restore done');
                        cb = undefined;
                    });
                }
            }
        });
    }
    catch (err) {
        if (cb) {
            cb(err);
            cb = undefined;
        }
    }
}
exports.isStop = false;
//# sourceMappingURL=influxDB.js.map