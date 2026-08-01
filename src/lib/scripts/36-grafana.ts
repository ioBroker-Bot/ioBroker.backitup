import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, remove } from 'fs-extra';
import { Agent } from 'node:https';
import axios from 'axios';

import { getDate } from '../tools';
import { compress } from '../targz';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface GrafanaOptions {
    context: BackItUpExecuteContext;
    protocol: 'http' | 'https';
    host: string;
    port: string | number;
    apiKey: string;
    backupDir: string;
    signedCertificates: boolean;
    hostType?: 'Single' | 'Master' | 'Slave';
    slaveSuffix?: string;
    nameSuffix?: string;
}

let waitCompress: NodeJS.Timeout | undefined;
let timerLog: NodeJS.Timeout | undefined;

/**
 * Text stored in `context.errors.grafana`.
 *
 * This used to be `JSON.stringify(err)`. For an axios rejection that serialises the whole request
 * config - including the `Authorization: Bearer <apiKey>` header - so the API key ended up in the
 * notification text. Only the message is kept now.
 *
 * The `String(err)` fallback matters: a thrown non-Error has no `message`, and storing `undefined`
 * would put the literal word "undefined" into the notification.
 *
 * @param err whatever was thrown
 */
function errText(err: any): string {
    return err?.message ?? String(err);
}

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        timerLog = setTimeout(() => resolve(), ms);
    });
}

async function getData(
    options: GrafanaOptions,
    log: ioBroker.Logger,
    dashboardDir: string,
    folderDir: string,
    datasourceDir: string,
    dashboardManuallyDir: string,
    tmpDir: string,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    return new Promise(resolve => {
        void (async (): Promise<void> => {
            let available;
            const dashboardFolderMap: Record<string, string> = {};

            try {
                available = await axios({
                    method: 'get',
                    url: `${options.protocol}://${options.host}:${options.port}`,
                    validateStatus: () => true,
                    httpsAgent: new Agent({
                        rejectUnauthorized: options.signedCertificates,
                    }),
                });
            } catch (err) {
                options.context.errors.grafana = errText(err);
                log.error(`Grafana is not available: ${err}`);
            }

            if (available && available.status) {
                log.debug(`Grafana is available ... Status: ${available.status}`);

                // Load datasource
                try {
                    const dataSourcesRequest = await axios({
                        method: 'get',
                        url: `${options.protocol}://${options.host}:${options.port}/api/datasources`,
                        headers: { Authorization: `Bearer ${options.apiKey}` },
                        responseType: 'json',
                        httpsAgent: new Agent({
                            rejectUnauthorized: options.signedCertificates,
                        }),
                    });

                    await Promise.all(
                        dataSourcesRequest.data.map(async (dataSource: { name: string }) => {
                            await writeFile(
                                `${datasourceDir}/${dataSource.name}.json`,
                                JSON.stringify(dataSource, null, 2),
                            );
                        }),
                    );
                } catch (err) {
                    options.context.errors.grafana = errText(err);
                    log.error('Error on Grafana Datasource Request');
                }

                // Load Dashboards
                const dashBoards: string[] = [];

                try {
                    const dashBoardsRequest = await axios({
                        method: 'get',
                        url: `${options.protocol}://${options.host}:${options.port}/api/search`,
                        headers: { Authorization: `Bearer ${options.apiKey}` },
                        responseType: 'json',
                        httpsAgent: new Agent({
                            rejectUnauthorized: options.signedCertificates,
                        }),
                    });

                    await Promise.all(
                        dashBoardsRequest.data.map(async (item: { type: string; uri: string; uid: string }) => {
                            if (item.type === 'dash-db' && !dashBoards.includes(item.uri)) {
                                dashBoards.push(`${item.uid}:${item.uri.split('/').pop()}`);
                            }
                        }),
                    );
                } catch (err) {
                    options.context.errors.grafana = errText(err);
                    log.error(`Error on Grafana Dashboard Request: ${err}`);
                }

                try {
                    await Promise.all(
                        dashBoards.map(async dashBoard => {
                            const dashBoardData = dashBoard.split(':');
                            let dashBoardRequest;

                            try {
                                dashBoardRequest = await axios({
                                    method: 'get',
                                    url: `${options.protocol}://${options.host}:${options.port}/api/dashboards/uid/${dashBoardData[0]}`,
                                    headers: { Authorization: `Bearer ${options.apiKey}` },
                                    responseType: 'json',
                                    httpsAgent: new Agent({
                                        rejectUnauthorized: options.signedCertificates,
                                    }),
                                });
                            } catch (err) {
                                options.context.errors.grafana = errText(err);
                                log.error(`Error on Grafana Dashboard ${dashBoardData[0]} backup: ${err}`);
                            }

                            log.debug(`found Dashboard: ${dashBoardData[1]}`);
                            await sleep(300);

                            // Deliberately unguarded: if the request above failed this throws and is
                            // caught by the surrounding try, exactly as before. The non-null
                            // assertion is what tsc needs here; eslint's program runs without
                            // strictNullChecks and therefore considers it redundant.
                            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                            const changedJSON = dashBoardRequest!.data;
                            const folderUid = changedJSON.meta?.folderUid || 'general';

                            dashboardFolderMap[dashBoardData[1]] = folderUid;

                            delete changedJSON.meta;
                            changedJSON.dashboard.id = null;
                            changedJSON.overwrite = true;

                            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                            const manuellJSON = dashBoardRequest!.data.dashboard;

                            manuellJSON.id = null;
                            try {
                                await writeFile(
                                    join(dashboardDir, `${dashBoardData[1]}.json`).replace(/\\/g, '/'),
                                    JSON.stringify(changedJSON, null, 2),
                                );
                            } catch (e) {
                                options.context.errors.grafana = errText(e);
                                log.error(`${dashBoardData[1]}.json cannot be written: ${e}`);
                            }

                            try {
                                await writeFile(
                                    join(dashboardManuallyDir, `${dashBoardData[1]}.json`).replace(/\\/g, '/'),
                                    JSON.stringify(manuellJSON, null, 2),
                                );
                            } catch (e) {
                                options.context.errors.grafana = errText(e);
                                log.error(`${dashBoardData[1]}.json cannot be written: ${e}`);
                            }
                        }),
                    );
                } catch (err) {
                    options.context.errors.grafana = errText(err);
                    log.error(`Error on Grafana Dashboard backup: ${err}`);
                }

                // Backup Folder UID
                try {
                    const mapFilePath = join(folderDir, 'dashboard_folder_map.json').replace(/\\/g, '/');
                    await writeFile(mapFilePath, JSON.stringify(dashboardFolderMap, null, 2));
                    log.debug('Saved dashboard-folder mapping');
                } catch (err) {
                    options.context.errors.grafana = errText(err);
                    log.error(`Error writing dashboard-folder mapping: ${err}`);
                }

                // Backup folders
                try {
                    const foldersRequest = await axios({
                        method: 'get',
                        url: `${options.protocol}://${options.host}:${options.port}/api/folders`,
                        headers: { Authorization: `Bearer ${options.apiKey}` },
                        responseType: 'json',
                        httpsAgent: new Agent({
                            rejectUnauthorized: options.signedCertificates,
                        }),
                    });

                    await Promise.all(
                        foldersRequest.data.map(async (folder: { title: string; uid: string }) => {
                            const folderFilename = `${folder.title.replace(/[^a-z0-9]/gi, '_')}_${folder.uid}.json`;
                            const folderFilePath = join(folderDir, `${folderFilename}`).replace(/\\/g, '/');
                            try {
                                await writeFile(folderFilePath, JSON.stringify(folder, null, 2));
                                log.debug(`Save Folder "${folder.title}"`);
                                await sleep(300);
                            } catch (err) {
                                log.error(`Error write Folder "${folder.title}": ${err}`);
                            }
                        }),
                    );
                } catch (err) {
                    options.context.errors.grafana = errText(err);
                    log.error(`Error on Grafana-Folder: ${err}`);
                }

                // request finish
                resolve();
            } else {
                options.context.errors.grafana = 'Grafana is not available!';

                log.error('Grafana is not available!');
                log.debug(`Try deleting the Grafana tmp directory: "${tmpDir}"`);

                let cb = callback;
                try {
                    await delTmp(options, tmpDir, log);
                } catch (err) {
                    options.context.errors.grafana = errText(err);
                    clearTimeout(timerLog);
                    log.error(
                        `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
                    );
                    cb?.(null, err as Error);
                    cb = undefined;
                }

                log.error('Grafana Backup cannot created ...');
                clearTimeout(timerLog);
                cb?.(null, 'done');
            }
        })();
    });
}

export async function command(
    options: GrafanaOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    let cb = callback;

    if (options && options.protocol && options.host && options.port && options.apiKey) {
        const tmpDir = join(options.backupDir, 'grafana_tmp').replace(/\\/g, '/');
        const dashboardDir = join(tmpDir, 'dashboards').replace(/\\/g, '/');
        const folderDir = join(tmpDir, 'folder').replace(/\\/g, '/');
        const datasourceDir = join(tmpDir, 'datasource').replace(/\\/g, '/');
        const dashboardManuallyDir = join(tmpDir, 'dashboards_manually_restore').replace(/\\/g, '/');

        log.debug('Start Grafana Backup ...');

        const desiredMode = {
            mode: 0o2775,
        };

        if (!existsSync(tmpDir)) {
            try {
                await ensureDir(tmpDir, desiredMode);
            } catch (err) {
                options.context.errors.grafana = errText(err);
                log.error(`Grafana tmp directory "${tmpDir}" cannot created ... ${err}`);
            }
            log.debug(`Created grafana_tmp directory: "${tmpDir}"`);
        } else {
            try {
                await delTmp(options, tmpDir, log);
            } catch {
                log.error(
                    `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
                );
            }

            if (!existsSync(tmpDir)) {
                try {
                    await ensureDir(tmpDir, desiredMode);
                } catch (err) {
                    options.context.errors.grafana = errText(err);
                    log.error(`Grafana tmp directory "${tmpDir}" cannot created ... ${err}`);
                }
                log.debug('Created grafana_tmp directory');
            }
        }

        try {
            if (!existsSync(dashboardDir)) {
                await ensureDir(dashboardDir, desiredMode);
                log.debug('Created dashboard directory');
            }
            if (!existsSync(folderDir)) {
                await ensureDir(folderDir, desiredMode);
                log.debug('Created folder directory');
            }
            if (!existsSync(dashboardManuallyDir)) {
                await ensureDir(dashboardManuallyDir, desiredMode);
                log.debug('Created dashboards_manually_restore directory');
            }
            if (!existsSync(datasourceDir)) {
                await ensureDir(datasourceDir, desiredMode);
                log.debug('Created datasource directory');
            }
        } catch (err) {
            options.context.errors.grafana = errText(err);
            log.error(`Grafana Backup cannot created: ${err}`);
            clearTimeout(timerLog);
            // Note: not cleared here, so a later callback can still fire - as before.
            cb?.(err);
        }

        if (
            existsSync(tmpDir) &&
            existsSync(datasourceDir) &&
            existsSync(dashboardDir) &&
            existsSync(dashboardManuallyDir)
        ) {
            try {
                log.debug('start Grafana request ...');
                await getData(options, log, dashboardDir, folderDir, datasourceDir, dashboardManuallyDir, tmpDir, cb);
                log.debug('start Grafana backup compress ...');

                // compress Backup
                try {
                    const dashBoardFiles = await readdir(dashboardDir);
                    const dataSourcesFiles = await readdir(datasourceDir);

                    if (dataSourcesFiles.length !== 0 && dashBoardFiles.length !== 0) {
                        let nameSuffix;
                        if (options.hostType === 'Slave') {
                            nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
                        } else {
                            nameSuffix = options.nameSuffix ? options.nameSuffix : '';
                        }

                        const fileName = join(
                            options.backupDir,
                            `grafana_${getDate()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`,
                        );

                        options.context.fileNames.push(fileName);

                        waitCompress = setTimeout(
                            () =>
                                compress(
                                    {
                                        src: tmpDir,
                                        dest: fileName,
                                    },
                                    async err => {
                                        if (err) {
                                            options.context.errors.grafana = err.toString();
                                            clearTimeout(timerLog);
                                            if (cb) {
                                                cb(err);
                                                clearTimeout(waitCompress);
                                            }
                                        } else {
                                            log.debug(`Backup created: ${fileName}`);
                                            options.context.done.push('grafana');
                                            options.context.types.push('grafana');
                                            clearTimeout(timerLog);
                                            if (cb) {
                                                try {
                                                    await delTmp(options, tmpDir, log);
                                                } catch {
                                                    log.error(
                                                        `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
                                                    );
                                                }

                                                clearTimeout(timerLog);
                                                cb(null);
                                                cb = undefined;
                                                clearTimeout(waitCompress);
                                            }
                                        }
                                    },
                                ),
                            5000,
                        );
                    } else {
                        try {
                            await delTmp(options, tmpDir, log);
                        } catch {
                            log.error(
                                `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
                            );
                        }

                        log.error('cannot found Grafana Backup files');
                        clearTimeout(timerLog);
                        cb?.(null);
                        cb = undefined;
                        clearTimeout(waitCompress);
                    }
                } catch (e) {
                    options.context.errors.grafana = errText(e);
                    log.error(`Grafana Backup cannot created: ${e}`);

                    try {
                        await delTmp(options, tmpDir, log);
                    } catch {
                        log.error(
                            `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
                        );
                    }

                    clearTimeout(timerLog);
                    cb?.(null, e as Error);
                    cb = undefined;
                    clearTimeout(waitCompress);
                }
            } catch (e) {
                try {
                    await delTmp(options, tmpDir, log);
                } catch {
                    log.error(
                        `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
                    );
                }

                log.error(`Grafana Backup cannot created: ${e}`);
                clearTimeout(timerLog);
                cb?.(null, e as Error);
                cb = undefined;
                clearTimeout(waitCompress);
            }
        } else {
            log.error('Grafana Backup cannot created ...');
            clearTimeout(timerLog);
            cb?.(null);
            cb = undefined;
            clearTimeout(waitCompress);
        }
    } else {
        options.context.errors.grafana = 'Grafana Backup cannot created. Please check your Configuration';
        log.error('Grafana Backup cannot created. Please check your Configuration');
        clearTimeout(timerLog);
        cb?.(null);
    }
}

async function delTmp(options: GrafanaOptions, tmpDir: string, log: ioBroker.Logger): Promise<void> {
    log.debug(`Try deleting the Grafana tmp directory: "${tmpDir}"`);

    return remove(tmpDir)
        .then(() => {
            if (!existsSync(tmpDir)) {
                log.debug(`Grafana tmp directory "${tmpDir}" successfully deleted`);
            }
        })
        .catch(err => {
            options.context.errors.grafana = errText(err);
            log.error(
                `The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`,
            );
            throw err;
        });
}

export const ignoreErrors = true;
