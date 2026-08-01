"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const tools_1 = require("../tools");
const targz_1 = require("../targz");
async function command(options, log, callback) {
    if (options.mySqlMulti) {
        // The per-event settings are written onto `options` itself, one target after another.
        for (let i = 0; i < options.mySqlEvents.length; i++) {
            options.port = options.mySqlEvents[i].port ? options.mySqlEvents[i].port : '';
            options.host = options.mySqlEvents[i].host ? options.mySqlEvents[i].host : '';
            options.user = options.mySqlEvents[i].user ? options.mySqlEvents[i].user : '';
            options.pass = options.mySqlEvents[i].pass ? options.mySqlEvents[i].pass : '';
            options.exe = options.mySqlEvents[i].exe ? options.mySqlEvents[i].exe : '';
            options.dbName = options.mySqlEvents[i].dbName ? options.mySqlEvents[i].dbName : '';
            options.nameSuffix = options.mySqlEvents[i].nameSuffix ? options.mySqlEvents[i].nameSuffix : '';
            log.debug(`MySql-Backup for ${options.nameSuffix} is started ...`);
            await startBackup(options, log, callback);
            log.debug(`MySql-Backup for ${options.nameSuffix} is finish`);
        }
        // Reported as done even when a target failed - kept as found.
        options.context.done.push('mysql');
        options.context.types.push('mysql');
        callback?.(null);
        return;
    }
    else if (!options.mySqlMulti) {
        log.debug('MySql-Backup started ...');
        await startBackup(options, log, callback);
        log.debug('MySql-Backup for is finish');
        options.context.done.push('mysql');
        options.context.types.push('mysql');
        callback?.(null);
        return;
    }
}
/**
 * Dumps one database and packs the dump.
 *
 * The callback parameter is deliberately local: the original cleared it here, which never reached
 * `command`, so a failure is reported once from here and then again as a success from `command`.
 *
 * @param options script options, already pointed at the target to dump
 * @param log adapter logger
 * @param callback reports a dump or packing failure
 */
async function startBackup(options, log, callback) {
    return new Promise(resolve => {
        let localCallback = callback;
        let nameSuffix;
        if (options.hostType === 'Slave' && !options.mySqlMulti) {
            nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
        }
        else {
            nameSuffix = options.nameSuffix ? options.nameSuffix : '';
        }
        const fileName = (0, node_path_1.join)(options.backupDir, `mysql_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`);
        const fileNameMysql = (0, node_path_1.join)(options.backupDir, `mysql_${(0, tools_1.getDate)()}_backupiobroker.sql`);
        options.context.fileNames = options.context.fileNames || [];
        options.context.fileNames.push(fileName);
        // Note the asymmetry in the second clause - as in 01-mount, `endsWith("'")` is not negated.
        if ((!options.pass.startsWith(`"`) || !options.pass.endsWith(`"`)) &&
            (!options.pass.startsWith(`'`) || options.pass.endsWith(`'`))) {
            options.pass = `"${options.pass}"`;
        }
        (0, node_child_process_1.exec)(`${options.exe ? options.exe : 'mysqldump'}  -u ${options.user} -p${options.pass} ${options.dbName} -h ${options.host} -P ${options.port}${options.mysqlQuick ? ' --quick' : ''}${options.skipSSL ? ' --skip-ssl' : ''} > ${fileNameMysql}`, { maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
            if (error) {
                // `ExecException` is declared as Omit<ErrnoException, 'code'>, which drops the
                // nominal Error identity; binding it back keeps the formatted text the same.
                const failure = error;
                let errLog = `${failure}`;
                try {
                    const formatPass = options.pass.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                    errLog = errLog.replace(new RegExp(formatPass, 'g'), '****');
                }
                catch {
                    // ignore
                }
                options.context.errors.mysql = errLog.toString();
                localCallback?.(errLog, stderr);
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
                    src: fileNameMysql,
                    dest: fileName,
                    tar: {
                        map: header => {
                            header.name = fileNameMysql.split('/').pop();
                            return header;
                        },
                    },
                }, 
                // lib/targz only ever passes an error; the stdout/stderr parameters the
                // original declared here were always undefined.
                err => {
                    clearInterval(timer);
                    if (err) {
                        options.context.errors.mysql = err.toString();
                        if (localCallback) {
                            localCallback(err);
                            localCallback = undefined;
                        }
                        resolve();
                    }
                    else {
                        if (fileNameMysql) {
                            try {
                                (0, node_fs_1.unlinkSync)(fileNameMysql);
                                log.debug('MySql File deleted!');
                            }
                            catch (e) {
                                log.warn(`MySql File cannot deleted: ${e}`);
                            }
                        }
                        resolve();
                    }
                });
            }
        });
    });
}
exports.ignoreErrors = true;
//# sourceMappingURL=30-mysql.js.map