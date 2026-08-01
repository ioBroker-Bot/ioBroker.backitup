import { exec } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDirSync, removeSync } from 'fs-extra';

import { decompress } from '../targz';
import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

/** Both are validated by the command builder below, so the empty string is part of the domain. */
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

interface InfluxDbRestoreOptions extends BackItUpRestoreOptions {
    host: string;
    port: number | string;
    dbName: string;
    token: string;
    protocol: InfluxProtocol;
    dbversion: InfluxVersion;
    dbType: 'local' | 'remote';
    /** path to the influx/influxd binary; falls back to the one on PATH */
    exe?: string;
    /** drop the database before restoring - only honoured for local instances */
    deleteDatabase?: boolean;
    influxDBMulti?: boolean;
    influxDBEvents: InfluxDbEvent[];
    nameSuffix?: string;
}

/** The parts of an influx backup manifest this module reads */
interface InfluxManifest {
    files?: { database: string }[];
    buckets?: { bucketName: string }[];
}

/**
 * Runs the influx restore command against the unpacked dump.
 *
 * @param options connection settings; in multi mode these are re-pointed at the matching target
 * @param tmpDir directory the backup was unpacked into
 * @param log restore logger
 * @param callback reports the command exit status
 */
function replayInfluxDB(
    options: InfluxDbRestoreOptions,
    tmpDir: string,
    log: BackItUpRestoreLogger,
    callback?: BackItUpRestoreCallback,
): void {
    let dbName = options.dbName;

    if (options.influxDBMulti === true && existsSync(tmpDir)) {
        const files = readdirSync(tmpDir);

        try {
            files.forEach(function (file) {
                const currentFiletype = file.split('.').pop();

                if (currentFiletype === 'manifest') {
                    const manifest = readFileSync(join(tmpDir, file).replace(/\\/g, '/'));
                    const json: InfluxManifest = JSON.parse(manifest.toString());

                    options.dbversion = json.files ? '1.x' : json.buckets ? '2.x' : options.dbversion;
                    dbName =
                        options.dbversion === '1.x'
                            ? json.files![0].database
                            : options.dbversion === '2.x'
                              ? json.buckets![0].bucketName
                              : options.dbName;
                }
            });
        } catch (err) {
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
        } catch (err) {
            log.error(`InfluxDB config not found: ${err}`);
        }
    }

    const cmdDelete = `influx -execute='DROP DATABASE ${dbName}'`;
    // Stays undefined for any other version, and `exec(undefined)` then throws into the catch
    // below. Kept as found.
    let cmd: string | undefined;

    if (options.dbversion === '1.x') {
        cmd = `${options.exe ? `"${options.exe}"` : 'influxd'} restore -portable -db ${dbName}${options.dbType === 'remote' ? ` -host ${options.host}:${options.port}` : ''} "${tmpDir}"`;
    } else if (options.dbversion === '2.x') {
        // As in lib/scripts/12-influxDB the access token goes onto the command line.
        cmd = `${options.exe ? `"${options.exe}"` : 'influx'} restore --bucket ${dbName}${options.dbType === 'remote' ? ` --host ${options.protocol}://${options.host}:${options.port}` : ''} -t ${options.token} "${tmpDir}"`;
    }

    if (options.deleteDatabase && options.dbType === 'local') {
        try {
            exec(cmdDelete, (error, stdout) => {
                log.debug(stdout);

                // The original kept the ChildProcess in an unused `child` binding.
                exec(cmd!, (error, stdout, stderr) => {
                    if (error) {
                        log.error(stderr);
                    }
                    callback?.(error);
                });
            });
        } catch (e) {
            callback?.(e);
        }
    } else {
        try {
            // The original kept the ChildProcess in an unused `child` binding.
            exec(cmd!, (error, stdout, stderr) => {
                if (error) {
                    log.error(stderr);
                }
                callback?.(error);
            });
        } catch (e) {
            callback?.(e);
        }
    }
}

export function restore(
    options: InfluxDbRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    adapter: ioBroker.Adapter,
    callback?: BackItUpRestoreCallback,
): void {
    let cb = callback;

    const tmpDir = join(options.backupDir, 'influxDBtmp').replace(/\\/g, '/');

    // stop influxdb-Adapter before Restore
    let startAfterRestore = false;
    const enabledInstances: string[] = [];

    // Not awaited, so the instances may still be stopping when the replay starts. Kept as found.
    void adapter.getObjectView(
        'system',
        'instance',
        { startkey: 'system.adapter.influxdb.', endkey: 'system.adapter.influxdb.\u9999' },
        (err, instances) => {
            const resultInstances: { id: string; config: unknown }[] = [];
            if (!err && instances && instances.rows) {
                instances.rows.forEach(row =>
                    resultInstances.push({
                        id: row.id.replace('system.adapter.', ''),
                        config: row.value.native.type,
                    }),
                );
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
            } else {
                log.debug('Could not retrieve influxdb instances!');
            }
        },
    );

    // A string, so fs-extra reads no mode from it and falls back to the default. Kept as found.
    const desiredMode = '0o2775';

    if (!existsSync(tmpDir)) {
        ensureDirSync(tmpDir, desiredMode as unknown as number);
        log.debug('Created tmp directory');
    } else {
        try {
            log.debug('Try deleting the old InfluxDB tmp directory');
            removeSync(tmpDir);
            if (!existsSync(tmpDir)) {
                log.debug('InfluxDB old tmp directory was successfully deleted');
            }
            ensureDirSync(tmpDir, desiredMode as unknown as number);
            log.debug('Created tmp directory');
        } catch (e) {
            log.debug(`InfluxDB old tmp directory could not be deleted: ${e}`);
        }
    }
    log.debug('Start influxDB Restore ...');

    try {
        decompress(
            {
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
                } else {
                    if (cb) {
                        // The replay error is deliberately ignored - the step always reports success.
                        replayInfluxDB(options, tmpDir, log, () => {
                            // Start influxDB Instances
                            if (startAfterRestore) {
                                enabledInstances.forEach(enabledInstance => {
                                    void adapter.getForeignObject(
                                        `system.adapter.${enabledInstance}`,
                                        (err, obj) => {
                                            if (obj && !obj.common?.enabled) {
                                                void adapter.setForeignState(
                                                    `system.adapter.${enabledInstance}.alive`,
                                                    true,
                                                );
                                                log.debug(`${enabledInstance} started`);
                                            }
                                        },
                                    );
                                });
                            }
                            // delete influxDB tmpDir
                            if (existsSync(tmpDir)) {
                                try {
                                    log.debug('Try deleting the InfluxDB tmp directory');
                                    removeSync(tmpDir);
                                    if (!existsSync(tmpDir)) {
                                        log.debug('InfluxDB tmp directory was successfully deleted');
                                    }
                                } catch (e) {
                                    log.debug(`InfluxDB tmp directory could not be deleted: ${e}`);
                                }
                            }
                            log.debug('influxDB Restore completed successfully');
                            cb?.(null, 'influxDB restore done');
                            cb = undefined;
                        });
                    }
                }
            },
        );
    } catch (err) {
        if (cb) {
            cb(err);
            cb = undefined;
        }
    }
}

export const isStop = false;
