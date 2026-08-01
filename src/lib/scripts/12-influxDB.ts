import { exec } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, remove } from 'fs-extra';

import { getDate } from '../tools';
import { compress } from '../targz';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

/** Both are validated below, so the empty string is part of the domain. */
type InfluxProtocol = 'http' | 'https' | '';
type InfluxVersion = '1.x' | '2.x' | '';

interface InfluxDbEvent {
    host: string;
    port: number | string;
    dbName: string;
    nameSuffix: string;
    token: string;
    protocol: InfluxProtocol;
    dbversion: InfluxVersion;
}

interface InfluxDbOptions {
    context: BackItUpExecuteContext;
    backupDir: string;
    host: string;
    port: number | string;
    dbName: string;
    token: string;
    protocol: InfluxProtocol;
    dbversion: InfluxVersion;
    dbType: 'local' | 'remote';
    /** path to the influx/influxd binary; falls back to the one on PATH */
    exe?: string;
    influxDBMulti?: boolean;
    influxDBEvents: InfluxDbEvent[];
    hostType?: 'Single' | 'Master' | 'Slave';
    slaveSuffix?: string;
    nameSuffix?: string;
}

export async function command(
    options: InfluxDbOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
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
    } else if (!options.influxDBMulti) {
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
async function startBackup(
    options: InfluxDbOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    return new Promise(resolve => {
        void (async (): Promise<void> => {
            let localCallback = callback;

            let nameSuffix;
            if (options.hostType === 'Slave' && !options.influxDBMulti) {
                nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
            } else {
                nameSuffix = options.nameSuffix ? options.nameSuffix : '';
            }
            const fileName = join(
                options.backupDir,
                `influxDB_${getDate()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`,
            );
            const tmpDir = join(
                options.backupDir,
                `influxDB_${getDate()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker`,
            );

            options.context.fileNames.push(fileName);

            log.debug('Start InfluxDB Backup ...');

            const desiredMode = {
                mode: 0o2775,
            };

            if (!existsSync(tmpDir)) {
                try {
                    await ensureDir(tmpDir, desiredMode);
                } catch {
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
            } else {
                influxDBCMD = `${options.exe ? `"${options.exe}"` : 'influxd'} backup -portable -database ${options.dbName}${options.dbType === 'remote' ? ` -host ${options.host}:${options.port}` : ''} "${tmpDir}"`;
            }

            if (
                ((options.dbversion === '2.x' && options.token !== '' && options.dbName !== '') ||
                    (options.dbversion === '1.x' && options.dbName !== '')) &&
                ((options.dbType === 'remote' && options.protocol !== '' && options.host !== '') ||
                    options.dbType === 'local')
            ) {
                exec(influxDBCMD, { maxBuffer: 10 * 1024 * 1024 }, async (error, stdout, stderr) => {
                    if (error) {
                        // `ExecException` is declared as Omit<ErrnoException, 'code'>, which drops
                        // the nominal Error identity; binding it back keeps toString() identical.
                        const failure: Error = error;
                        options.context.errors.influxDB = failure.toString();
                        if (existsSync(tmpDir)) {
                            try {
                                await delTmp(options, tmpDir, log);
                            } catch {
                                log.error(
                                    `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
                                );
                            }
                        }
                        log.debug(stdout);
                        localCallback?.(error, stderr);
                        localCallback = undefined;
                        resolve();
                    } else {
                        const timer = setInterval(() => {
                            if (existsSync(fileName)) {
                                const stats = statSync(fileName);
                                const fileSize = Math.floor(stats.size / (1024 * 1024));
                                log.debug(`Packed ${fileSize}MB so far...`);
                            }
                        }, 10000);

                        compress(
                            {
                                src: tmpDir,
                                dest: fileName,
                            },
                            // lib/targz only ever passes an error; the stdout/stderr parameters the
                            // original declared here were always undefined.
                            async err => {
                                clearInterval(timer);
                                if (err) {
                                    options.context.errors.influxDB = err.toString();
                                    try {
                                        await delTmp(options, tmpDir, log);
                                    } catch {
                                        log.error(
                                            `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
                                        );
                                    }

                                    if (localCallback) {
                                        localCallback(err);
                                        localCallback = undefined;
                                    }
                                    resolve();
                                } else {
                                    log.debug(`Backup created: ${fileName}`);

                                    if (existsSync(tmpDir)) {
                                        try {
                                            await delTmp(options, tmpDir, log);
                                        } catch {
                                            log.error(
                                                `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
                                            );
                                        }
                                    }
                                    resolve();
                                }
                            },
                        );
                    }
                });
            } else {
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
async function delTmp(options: InfluxDbOptions, tmpDir: string, log: ioBroker.Logger): Promise<void> {
    log.debug(`Try deleting the InfluxDB tmp directory: "${tmpDir}"`);

    return remove(tmpDir)
        .then(() => {
            if (!existsSync(tmpDir)) {
                log.debug(`InfluxDB tmp directory "${tmpDir}" successfully deleted`);
            }
        })
        .catch(err => {
            options.context.errors.influxDB = JSON.stringify(err);
            log.error(
                `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
            );
            throw err;
        });
}

export const ignoreErrors = true;
