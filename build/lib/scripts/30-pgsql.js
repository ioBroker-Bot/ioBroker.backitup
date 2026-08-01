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
    if (options.pgSqlMulti) {
        // The per-event settings are written onto `options` itself, one target after another.
        for (let i = 0; i < options.pgSqlEvents.length; i++) {
            options.port = options.pgSqlEvents[i].port ? options.pgSqlEvents[i].port : '';
            options.host = options.pgSqlEvents[i].host ? options.pgSqlEvents[i].host : '';
            options.user = options.pgSqlEvents[i].user ? options.pgSqlEvents[i].user : '';
            options.pass = options.pgSqlEvents[i].pass ? options.pgSqlEvents[i].pass : '';
            options.exe = options.pgSqlEvents[i].exe ? options.pgSqlEvents[i].exe : '';
            options.dbName = options.pgSqlEvents[i].dbName ? options.pgSqlEvents[i].dbName : '';
            options.nameSuffix = options.pgSqlEvents[i].nameSuffix ? options.pgSqlEvents[i].nameSuffix : '';
            log.debug(`PgSql-Backup for ${options.nameSuffix} is started ...`);
            await startBackup(options, log, callback);
            log.debug(`PgSql-Backup for ${options.nameSuffix} is finish`);
        }
        // Reported as done even when a target failed - kept as found.
        options.context.done.push('pgsql');
        options.context.types.push('pgsql');
        callback?.(null);
        return;
    }
    else if (!options.pgSqlMulti) {
        log.debug('PgSql-Backup started ...');
        await startBackup(options, log, callback);
        log.debug('PgSql-Backup for is finish');
        options.context.done.push('pgsql');
        options.context.types.push('pgsql');
        callback?.(null);
        return;
    }
}
/**
 * Dumps one database and packs the dump.
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
        let localCallback = callback;
        let nameSuffix;
        if (options.hostType === 'Slave' && !options.pgSqlMulti) {
            nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
        }
        else {
            nameSuffix = options.nameSuffix ? options.nameSuffix : '';
        }
        const fileName = (0, node_path_1.join)(options.backupDir, `pgsql_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`);
        const fileNamePgsql = (0, node_path_1.join)(options.backupDir, `pgsql_${(0, tools_1.getDate)()}_backupiobroker.sql`);
        options.context.fileNames = options.context.fileNames || [];
        options.context.fileNames.push(fileName);
        // Note the asymmetry in the second clause - as in 01-mount, `endsWith("'")` is not negated.
        if ((!options.pass.startsWith(`"`) || !options.pass.endsWith(`"`)) &&
            (!options.pass.startsWith(`'`) || options.pass.endsWith(`'`))) {
            options.pass = `"${options.pass}"`;
        }
        (0, node_child_process_1.exec)(`${options.exe ? options.exe : 'pg_dump'}  --dbname=postgresql://${options.user}:${options.pass}@${options.host}:${options.port}/${options.dbName} > ${fileNamePgsql}`, { maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
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
                options.context.errors.pgsql = errLog.toString();
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
                    src: fileNamePgsql,
                    dest: fileName,
                    tar: {
                        map: header => {
                            header.name = fileNamePgsql.split('/').pop();
                            return header;
                        },
                    },
                }, 
                // lib/targz only ever passes an error; the stdout/stderr parameters the
                // original declared here were always undefined.
                err => {
                    clearInterval(timer);
                    if (err) {
                        options.context.errors.pgsql = err.toString();
                        if (localCallback) {
                            localCallback(err);
                            localCallback = undefined;
                        }
                        resolve();
                    }
                    else {
                        if (fileNamePgsql) {
                            // Unlike 30-mysql this uses the async form and rethrows inside
                            // the callback, which surfaces as an uncaught exception rather
                            // than a warning. Kept as found.
                            (0, node_fs_1.unlink)(fileNamePgsql, unlinkErr => {
                                if (unlinkErr) {
                                    throw unlinkErr;
                                }
                                log.debug('postgresql File deleted!');
                            });
                        }
                        resolve();
                    }
                });
            }
        });
    });
}
exports.ignoreErrors = true;
//# sourceMappingURL=30-pgsql.js.map