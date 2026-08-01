import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import * as https from 'node:https';
import { join } from 'node:path';
import { ensureDirSync, removeSync } from 'fs-extra';
import axios from 'axios';

import { decompress } from '../targz';
import type { BackItUpRestoreCallback, BackItUpRestoreLogger, BackItUpRestoreOptions } from './types';

/** The connection settings, which may sit directly on the options or in a nested `grafana` slice */
interface GrafanaConnection {
    host?: string;
    port?: number | string;
    apiKey?: string;
    protocol?: 'http' | 'https';
    signedCertificates?: boolean;
}

interface GrafanaRestoreOptions extends BackItUpRestoreOptions, GrafanaConnection {
    grafana?: GrafanaConnection;
}

/** Module level, so a second restore overwrites the handles of the first. Kept as found. */
let waitRestore: NodeJS.Timeout | undefined;
let timerDone: NodeJS.Timeout | undefined;

/**
 * Pushes the unpacked datasources, folders and dashboards back into Grafana.
 *
 * Always resolves - every failure is only logged.
 *
 * @param options connection settings, flat or under `grafana`
 * @param log restore logger
 * @param tmpDir directory the backup was unpacked into
 */
async function postData(
    options: GrafanaRestoreOptions,
    log: BackItUpRestoreLogger,
    tmpDir: string,
): Promise<void> {
    const dashboardDir = join(tmpDir, 'dashboards').replace(/\\/g, '/');
    const datasourceDir = join(tmpDir, 'datasource').replace(/\\/g, '/');
    const folderDir = join(tmpDir, 'folder').replace(/\\/g, '/');
    const dashBoards = await readdir(dashboardDir);
    const dataSources = await readdir(datasourceDir);
    const folders = await readdir(folderDir);

    const host = options.host ? options.host : options.grafana!.host;
    const port = options.port ? options.port : options.grafana!.port;
    const apiKey = options.apiKey ? options.apiKey : options.grafana!.apiKey;
    const protocol = options.protocol ? options.protocol : options.grafana!.protocol;
    // NOTE: the final `: true` makes this truthy even when both flags are false, so certificate
    // verification cannot be switched off here. Kept as found - see also lib/scripts/70-ftp. When
    // the flag is falsy and no `grafana` slice exists this throws instead.
    const signedCertificates = options.signedCertificates
        ? options.signedCertificates
        : options.grafana!.signedCertificates
          ? options.grafana!.signedCertificates
          : true;

    // Check available
    let available;
    try {
        available = await axios({
            method: 'get',
            url: `${protocol}://${host}:${port}`,
            validateStatus: () => true,
            httpsAgent: new https.Agent({
                rejectUnauthorized: signedCertificates,
            }),
        });
    } catch (err) {
        log.debug(`Grafana is not available: ${err}`);
    }
    if (available?.status) {
        log.debug(`Grafana is available ... Status: ${available.status}`);

        // post datasource
        try {
            await Promise.all(
                dataSources.map(async dataSource => {
                    const dataSourcePth = join(datasourceDir, dataSource).replace(/\\/g, '/');
                    const dataSourceFile = await readFile(dataSourcePth);
                    const dataSourceName = dataSource.split('.').shift();
                    log.debug(`Try to Restore: ${dataSourcePth}`);

                    await axios({
                        method: 'POST',
                        baseURL: `${protocol}://${host}:${port}`,
                        url: '/api/datasources',
                        data: dataSourceFile,
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${apiKey}`,
                        },
                        httpsAgent: new https.Agent({
                            rejectUnauthorized: signedCertificates,
                        }),
                    })
                        .then(result => {
                            log.debug(
                                `datasoure restore "${dataSourceName}" finish: ${JSON.stringify(result.data)}`,
                            );
                        })
                        .catch(err => {
                            // Reaches into `err.response` unguarded, so a network-level failure
                            // throws here and is reported by the outer catch instead.
                            log.debug(
                                `cannot restore datasource "${dataSourceName}": ${JSON.stringify(err.response.data.message)}`,
                            );
                        });
                }),
            );
        } catch (err) {
            log.debug(`Grafana datasource restore not possible: ${err}`);
        }

        // restore folders
        try {
            await Promise.all(
                folders.map(async folderFile => {
                    const folderPath = join(folderDir, folderFile).replace(/\\/g, '/');
                    const folderJson = JSON.parse(await readFile(folderPath, 'utf8'));
                    const folderTitle = folderJson.title;
                    const folderUid = folderJson.uid;

                    if (folderUid) {
                        log.debug(`Try to restore folder: ${folderTitle} (${folderUid})`);

                        await axios({
                            method: 'POST',
                            baseURL: `${protocol}://${host}:${port}`,
                            url: '/api/folders',
                            data: folderJson,
                            headers: {
                                'Content-Type': 'application/json',
                                Authorization: `Bearer ${apiKey}`,
                            },
                            httpsAgent: new https.Agent({
                                rejectUnauthorized: signedCertificates,
                            }),
                        })
                            .then(() => {
                                log.debug(`Folder "${folderTitle}" restored`);
                            })
                            .catch(err => {
                                const message = err.response?.data?.message || err.message;
                                log.debug(`Cannot restore folder "${folderTitle}": ${message}`);
                            });
                    }
                }),
            );
        } catch (err) {
            log.debug(`Grafana folder restore not possible: ${err}`);
        }

        const folderMapPath = join(folderDir, 'dashboard_folder_map.json').replace(/\\/g, '/');
        let dashboardFolderMap: Record<string, string> = {};

        try {
            const mapData = await readFile(folderMapPath, 'utf8');
            dashboardFolderMap = JSON.parse(mapData);
            log.debug(`Loaded dashboard-folder mapping with ${Object.keys(dashboardFolderMap).length} entries`);
        } catch (err) {
            log.debug(`No dashboard-folder mapping found or invalid: ${err}`);
        }

        // post Dashboards
        try {
            await Promise.all(
                dashBoards.map(async dashBoard => {
                    const dashBoardPth = join(dashboardDir, dashBoard).replace(/\\/g, '/');
                    const dashBoardFile = await readFile(dashBoardPth);
                    const dashBoardName = dashBoard.split('.').shift()!;
                    log.debug(`Try to Restore: ${dashBoardPth}`);

                    const apiOptions = {
                        baseURL: `${protocol}://${host}:${port}`,
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${apiKey}`,
                        },
                        httpsAgent: new https.Agent({
                            rejectUnauthorized: signedCertificates,
                        }),
                    };

                    const dashJson = JSON.parse(dashBoardFile.toString());
                    const folderUid = dashboardFolderMap[dashBoardName];

                    if (folderUid && folderUid !== 'general') {
                        dashJson.folderUid = folderUid;
                    }

                    await axios
                        .post('/api/dashboards/db', dashJson, apiOptions)
                        .then(result =>
                            log.debug(
                                `dashboard restore for "${dashBoardName}" finish: ${JSON.stringify(result.data)}`,
                            ),
                        )
                        .catch(err =>
                            // Same unguarded `err.response` access as above.
                            log.debug(
                                `cannot restore dashboard "${dashBoardName}": ${JSON.stringify(err.response.data)}`,
                            ),
                        );
                }),
            );
        } catch (err) {
            log.debug(`Grafana dashboard restore not possible: ${err}`);
        }
        // request finish
    } else {
        log.debug('Grafana is not available!');
        // request finish
    }
}

export function restore(
    options: GrafanaRestoreOptions,
    fileName: string,
    log: BackItUpRestoreLogger,
    _adapter: ioBroker.Adapter,
    callback?: BackItUpRestoreCallback,
): void {
    let cb = callback;

    if (
        (options && options.host && options.port && options.apiKey && options.protocol) ||
        (options &&
            options.grafana &&
            options.grafana.host &&
            options.grafana.port &&
            options.grafana.apiKey &&
            options.grafana.protocol)
    ) {
        log.debug('Start Grafana Restore ...');

        const tmpDir = join(options.backupDir, 'grafana_tmp').replace(/\\/g, '/');

        log.debug(`filename for restore: ${fileName}`);

        if (existsSync(tmpDir)) {
            try {
                removeSync(tmpDir);
                if (!existsSync(tmpDir)) {
                    log.debug('old Grafana tmp directory was successfully deleted');
                }
            } catch {
                log.debug('old Grafana tmp directory cannot deleted');
            }
        }
        // A string, so fs-extra reads no mode from it and falls back to the default. Kept as found.
        const desiredMode = '0o2775';

        try {
            ensureDirSync(tmpDir, desiredMode as unknown as number);
            log.debug(`Grafana tmp directory created: ${tmpDir}`);
        } catch (e) {
            log.debug(`Grafana tmp directory cannot created: ${e}`);
        }

        try {
            log.debug('start decompress');

            waitRestore = setTimeout(
                () =>
                    decompress(
                        {
                            src: fileName,
                            dest: tmpDir,
                        },
                        // lib/targz only ever passes an error, so the `stderr` the original
                        // forwarded as the exit code was always undefined.
                        async err => {
                            if (err) {
                                log.error('Grafana restore not completed');
                                log.error(err);
                                if (cb) {
                                    cb(err);
                                    cb = undefined;
                                    clearTimeout(timerDone);
                                    clearTimeout(waitRestore);
                                }
                            } else {
                                if (cb) {
                                    try {
                                        log.debug('Grafana request started');
                                        await postData(options, log, tmpDir);
                                        log.debug('Grafana request ended');

                                        log.debug('Try deleting the Grafana tmp directory');
                                        removeSync(tmpDir);
                                        if (!existsSync(tmpDir)) {
                                            log.debug('Grafana tmp directory was successfully deleted');
                                        }
                                    } catch (err) {
                                        // Clears the callback but does not return, so the timer
                                        // below is still armed and only logs afterwards.
                                        cb?.(err);
                                        cb = undefined;
                                        clearTimeout(timerDone);
                                        clearTimeout(waitRestore);
                                    }
                                    timerDone = setTimeout(() => {
                                        log.debug('Grafana Restore completed successfully');
                                        cb?.(null, 'Grafana restore done');
                                        cb = undefined;
                                        clearTimeout(timerDone);
                                        clearTimeout(waitRestore);
                                    }, 2000);
                                }
                            }
                        },
                    ),
                1000,
            );
        } catch (e) {
            if (cb) {
                cb(e);
                cb = undefined;
                clearTimeout(timerDone);
                clearTimeout(waitRestore);
            }
        }
    } else {
        log.debug('Grafana restore not completed. Please check your Configuration');
        cb?.(null, 'Grafana restore not completed. Please check your Configuration');
    }
}

export const isStop = false;
