"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const fs_extra_1 = require("fs-extra");
const tools_1 = require("../tools");
const targz_1 = require("../targz");
async function command(options, log, callback) {
    if (options.influxDBMulti) {
        // The per-event settings are written onto `options` itself, one target after another.
        for (let i = 0; i < options.influxDBEvents.length; i++) {
            options.port = options.influxDBEvents[i].port ? options.influxDBEvents[i].port : '';
            options.host = options.influxDBEvents[i].host ? options.influxDBEvents[i].host : '';
            options.dbName = options.influxDBEvents[i].dbName ? options.influxDBEvents[i].dbName : '';
            options.nameSuffix = options.influxDBEvents[i].nameSuffix ? options.influxDBEvents[i].nameSuffix : '';
            options.token = options.influxDBEvents[i].token ? options.influxDBEvents[i].token : '';
            options.dbversion = options.influxDBEvents[i].dbversion ? options.influxDBEvents[i].dbversion : '';
            options.protocol = options.influxDBEvents[i].protocol ? options.influxDBEvents[i].protocol : '';
            log.debug(`InfluxDB-Backup for ${options.nameSuffix} is started ...`);
            await startBackup(options, log, callback);
            log.debug(`InfluxDB-Backup for ${options.nameSuffix} is finish`);
        }
        // Reported as done even when a target failed - kept as found.
        options.context.done.push('influxDB');
        options.context.types.push('influxDB');
        callback?.(null);
        return;
    }
    else if (!options.influxDBMulti) {
        log.debug('InfluxDB-Backup started ...');
        await startBackup(options, log, callback);
        log.debug('InfluxDB-Backup for is finish');
        options.context.done.push('influxDB');
        options.context.types.push('influxDB');
        callback?.(null);
        return;
    }
}
/**
 * Dumps one bucket/database and packs the result.
 *
 * As in 30-mysql the callback parameter is deliberately local: clearing it here never reached
 * `command`, so a failure is reported once from here and then again as a success from `command`.
 *
 * @param options script options, already pointed at the target to dump
 * @param log adapter logger
 * @param callback reports a dump or packing failure
 */
async function startBackup(options, log, callback) {
    return new Promise(resolve => {
        void (async () => {
            let localCallback = callback;
            let nameSuffix;
            if (options.hostType === 'Slave' && !options.influxDBMulti) {
                nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
            }
            else {
                nameSuffix = options.nameSuffix ? options.nameSuffix : '';
            }
            const fileName = (0, node_path_1.join)(options.backupDir, `influxDB_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`);
            const tmpDir = (0, node_path_1.join)(options.backupDir, `influxDB_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker`);
            options.context.fileNames.push(fileName);
            log.debug('Start InfluxDB Backup ...');
            const desiredMode = {
                mode: 0o2775,
            };
            if (!(0, node_fs_1.existsSync)(tmpDir)) {
                try {
                    await (0, fs_extra_1.ensureDir)(tmpDir, desiredMode);
                }
                catch {
                    log.warn('InfluxDB Backup tmp directory cannot created ');
                }
                log.debug('InfluxDB Backup tmp directory created ');
            }
            // NOTE: the 2.x variant puts the access token straight into the command line. When the
            // command fails, `error.toString()` starts with "Command failed: <command>" and is
            // stored in `context.errors.influxDB` - which the notification channels print without
            // masking it (unlike the mysql/pgsql passwords, which are scrubbed at the source).
            let influxDBCMD;
            if (options.dbversion === '2.x') {
                influxDBCMD = `${options.exe ? `"${options.exe}"` : 'influx'} backup --bucket ${options.dbName}${options.dbType === 'remote' ? ` --host ${options.protocol}://${options.host}:${options.port}${options.protocol === 'https' ? ' --skip-verify' : ''}` : ''} -t ${options.token} "${tmpDir}"`;
            }
            else {
                influxDBCMD = `${options.exe ? `"${options.exe}"` : 'influxd'} backup -portable -database ${options.dbName}${options.dbType === 'remote' ? ` -host ${options.host}:${options.port}` : ''} "${tmpDir}"`;
            }
            if (((options.dbversion === '2.x' && options.token !== '' && options.dbName !== '') ||
                (options.dbversion === '1.x' && options.dbName !== '')) &&
                ((options.dbType === 'remote' && options.protocol !== '' && options.host !== '') ||
                    options.dbType === 'local')) {
                (0, node_child_process_1.exec)(influxDBCMD, { maxBuffer: 10 * 1024 * 1024 }, async (error, stdout, stderr) => {
                    if (error) {
                        // `ExecException` is declared as Omit<ErrnoException, 'code'>, which drops
                        // the nominal Error identity; binding it back keeps toString() identical.
                        const failure = error;
                        options.context.errors.influxDB = failure.toString();
                        if ((0, node_fs_1.existsSync)(tmpDir)) {
                            try {
                                await delTmp(options, tmpDir, log);
                            }
                            catch {
                                log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
                            }
                        }
                        log.debug(stdout);
                        localCallback?.(error, stderr);
                        localCallback = undefined;
                        resolve();
                    }
                    else {
                        const timer = setInterval(() => {
                            if ((0, node_fs_1.existsSync)(fileName)) {
                                const stats = (0, node_fs_1.statSync)(fileName);
                                const fileSize = Math.floor(stats.size / (1024 * 1024));
                                log.debug(`Packed ${fileSize}MB so far...`);
                            }
                        }, 10000);
                        (0, targz_1.compress)({
                            src: tmpDir,
                            dest: fileName,
                        }, 
                        // lib/targz only ever passes an error; the stdout/stderr parameters the
                        // original declared here were always undefined.
                        async (err) => {
                            clearInterval(timer);
                            if (err) {
                                options.context.errors.influxDB = err.toString();
                                try {
                                    await delTmp(options, tmpDir, log);
                                }
                                catch {
                                    log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
                                }
                                if (localCallback) {
                                    localCallback(err);
                                    localCallback = undefined;
                                }
                                resolve();
                            }
                            else {
                                log.debug(`Backup created: ${fileName}`);
                                if ((0, node_fs_1.existsSync)(tmpDir)) {
                                    try {
                                        await delTmp(options, tmpDir, log);
                                    }
                                    catch {
                                        log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
                                    }
                                }
                                resolve();
                            }
                        });
                    }
                });
            }
            else {
                log.error('Please check the Config from InfluxDB');
                resolve();
            }
        })();
    });
}
/**
 * Removes the temporary dump directory, rejecting when it cannot be deleted.
 *
 * @param options script options, for the error store
 * @param tmpDir directory to remove
 * @param log adapter logger
 */
async function delTmp(options, tmpDir, log) {
    log.debug(`Try deleting the InfluxDB tmp directory: "${tmpDir}"`);
    return (0, fs_extra_1.remove)(tmpDir)
        .then(() => {
        if (!(0, node_fs_1.existsSync)(tmpDir)) {
            log.debug(`InfluxDB tmp directory "${tmpDir}" successfully deleted`);
        }
    })
        .catch(err => {
        options.context.errors.influxDB = JSON.stringify(err);
        log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
        throw err;
    });
}
exports.ignoreErrors = true;
//# sourceMappingURL=12-influxDB.js.map