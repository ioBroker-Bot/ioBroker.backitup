"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const fs_extra_1 = require("fs-extra");
const node_https_1 = require("node:https");
const axios_1 = __importDefault(require("axios"));
const tools_1 = require("../tools");
const targz_1 = require("../targz");
let waitCompress;
let timerLog;
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
function errText(err) {
    return err?.message ?? String(err);
}
async function sleep(ms) {
    return new Promise(resolve => {
        timerLog = setTimeout(() => resolve(), ms);
    });
}
async function getData(options, log, dashboardDir, folderDir, datasourceDir, dashboardManuallyDir, tmpDir, callback) {
    return new Promise(resolve => {
        void (async () => {
            let available;
            const dashboardFolderMap = {};
            try {
                available = await (0, axios_1.default)({
                    method: 'get',
                    url: `${options.protocol}://${options.host}:${options.port}`,
                    validateStatus: () => true,
                    httpsAgent: new node_https_1.Agent({
                        rejectUnauthorized: options.signedCertificates,
                    }),
                });
            }
            catch (err) {
                options.context.errors.grafana = errText(err);
                log.error(`Grafana is not available: ${err}`);
            }
            if (available && available.status) {
                log.debug(`Grafana is available ... Status: ${available.status}`);
                // Load datasource
                try {
                    const dataSourcesRequest = await (0, axios_1.default)({
                        method: 'get',
                        url: `${options.protocol}://${options.host}:${options.port}/api/datasources`,
                        headers: { Authorization: `Bearer ${options.apiKey}` },
                        responseType: 'json',
                        httpsAgent: new node_https_1.Agent({
                            rejectUnauthorized: options.signedCertificates,
                        }),
                    });
                    await Promise.all(dataSourcesRequest.data.map(async (dataSource) => {
                        await (0, promises_1.writeFile)(`${datasourceDir}/${dataSource.name}.json`, JSON.stringify(dataSource, null, 2));
                    }));
                }
                catch (err) {
                    options.context.errors.grafana = errText(err);
                    log.error('Error on Grafana Datasource Request');
                }
                // Load Dashboards
                const dashBoards = [];
                try {
                    const dashBoardsRequest = await (0, axios_1.default)({
                        method: 'get',
                        url: `${options.protocol}://${options.host}:${options.port}/api/search`,
                        headers: { Authorization: `Bearer ${options.apiKey}` },
                        responseType: 'json',
                        httpsAgent: new node_https_1.Agent({
                            rejectUnauthorized: options.signedCertificates,
                        }),
                    });
                    await Promise.all(dashBoardsRequest.data.map(async (item) => {
                        if (item.type === 'dash-db' && !dashBoards.includes(item.uri)) {
                            dashBoards.push(`${item.uid}:${item.uri.split('/').pop()}`);
                        }
                    }));
                }
                catch (err) {
                    options.context.errors.grafana = errText(err);
                    log.error(`Error on Grafana Dashboard Request: ${err}`);
                }
                try {
                    await Promise.all(dashBoards.map(async (dashBoard) => {
                        const dashBoardData = dashBoard.split(':');
                        let dashBoardRequest;
                        try {
                            dashBoardRequest = await (0, axios_1.default)({
                                method: 'get',
                                url: `${options.protocol}://${options.host}:${options.port}/api/dashboards/uid/${dashBoardData[0]}`,
                                headers: { Authorization: `Bearer ${options.apiKey}` },
                                responseType: 'json',
                                httpsAgent: new node_https_1.Agent({
                                    rejectUnauthorized: options.signedCertificates,
                                }),
                            });
                        }
                        catch (err) {
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
                        const changedJSON = dashBoardRequest.data;
                        const folderUid = changedJSON.meta?.folderUid || 'general';
                        dashboardFolderMap[dashBoardData[1]] = folderUid;
                        delete changedJSON.meta;
                        changedJSON.dashboard.id = null;
                        changedJSON.overwrite = true;
                        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                        const manuellJSON = dashBoardRequest.data.dashboard;
                        manuellJSON.id = null;
                        try {
                            await (0, promises_1.writeFile)((0, node_path_1.join)(dashboardDir, `${dashBoardData[1]}.json`).replace(/\\/g, '/'), JSON.stringify(changedJSON, null, 2));
                        }
                        catch (e) {
                            options.context.errors.grafana = errText(e);
                            log.error(`${dashBoardData[1]}.json cannot be written: ${e}`);
                        }
                        try {
                            await (0, promises_1.writeFile)((0, node_path_1.join)(dashboardManuallyDir, `${dashBoardData[1]}.json`).replace(/\\/g, '/'), JSON.stringify(manuellJSON, null, 2));
                        }
                        catch (e) {
                            options.context.errors.grafana = errText(e);
                            log.error(`${dashBoardData[1]}.json cannot be written: ${e}`);
                        }
                    }));
                }
                catch (err) {
                    options.context.errors.grafana = errText(err);
                    log.error(`Error on Grafana Dashboard backup: ${err}`);
                }
                // Backup Folder UID
                try {
                    const mapFilePath = (0, node_path_1.join)(folderDir, 'dashboard_folder_map.json').replace(/\\/g, '/');
                    await (0, promises_1.writeFile)(mapFilePath, JSON.stringify(dashboardFolderMap, null, 2));
                    log.debug('Saved dashboard-folder mapping');
                }
                catch (err) {
                    options.context.errors.grafana = errText(err);
                    log.error(`Error writing dashboard-folder mapping: ${err}`);
                }
                // Backup folders
                try {
                    const foldersRequest = await (0, axios_1.default)({
                        method: 'get',
                        url: `${options.protocol}://${options.host}:${options.port}/api/folders`,
                        headers: { Authorization: `Bearer ${options.apiKey}` },
                        responseType: 'json',
                        httpsAgent: new node_https_1.Agent({
                            rejectUnauthorized: options.signedCertificates,
                        }),
                    });
                    await Promise.all(foldersRequest.data.map(async (folder) => {
                        const folderFilename = `${folder.title.replace(/[^a-z0-9]/gi, '_')}_${folder.uid}.json`;
                        const folderFilePath = (0, node_path_1.join)(folderDir, `${folderFilename}`).replace(/\\/g, '/');
                        try {
                            await (0, promises_1.writeFile)(folderFilePath, JSON.stringify(folder, null, 2));
                            log.debug(`Save Folder "${folder.title}"`);
                            await sleep(300);
                        }
                        catch (err) {
                            log.error(`Error write Folder "${folder.title}": ${err}`);
                        }
                    }));
                }
                catch (err) {
                    options.context.errors.grafana = errText(err);
                    log.error(`Error on Grafana-Folder: ${err}`);
                }
                // request finish
                resolve();
            }
            else {
                options.context.errors.grafana = 'Grafana is not available!';
                log.error('Grafana is not available!');
                log.debug(`Try deleting the Grafana tmp directory: "${tmpDir}"`);
                let cb = callback;
                try {
                    await delTmp(options, tmpDir, log);
                }
                catch (err) {
                    options.context.errors.grafana = errText(err);
                    clearTimeout(timerLog);
                    log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
                    cb?.(null, err);
                    cb = undefined;
                }
                log.error('Grafana Backup cannot created ...');
                clearTimeout(timerLog);
                cb?.(null, 'done');
            }
        })();
    });
}
async function command(options, log, callback) {
    let cb = callback;
    if (options && options.protocol && options.host && options.port && options.apiKey) {
        const tmpDir = (0, node_path_1.join)(options.backupDir, 'grafana_tmp').replace(/\\/g, '/');
        const dashboardDir = (0, node_path_1.join)(tmpDir, 'dashboards').replace(/\\/g, '/');
        const folderDir = (0, node_path_1.join)(tmpDir, 'folder').replace(/\\/g, '/');
        const datasourceDir = (0, node_path_1.join)(tmpDir, 'datasource').replace(/\\/g, '/');
        const dashboardManuallyDir = (0, node_path_1.join)(tmpDir, 'dashboards_manually_restore').replace(/\\/g, '/');
        log.debug('Start Grafana Backup ...');
        const desiredMode = {
            mode: 0o2775,
        };
        if (!(0, node_fs_1.existsSync)(tmpDir)) {
            try {
                await (0, fs_extra_1.ensureDir)(tmpDir, desiredMode);
            }
            catch (err) {
                options.context.errors.grafana = errText(err);
                log.error(`Grafana tmp directory "${tmpDir}" cannot created ... ${err}`);
            }
            log.debug(`Created grafana_tmp directory: "${tmpDir}"`);
        }
        else {
            try {
                await delTmp(options, tmpDir, log);
            }
            catch {
                log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
            }
            if (!(0, node_fs_1.existsSync)(tmpDir)) {
                try {
                    await (0, fs_extra_1.ensureDir)(tmpDir, desiredMode);
                }
                catch (err) {
                    options.context.errors.grafana = errText(err);
                    log.error(`Grafana tmp directory "${tmpDir}" cannot created ... ${err}`);
                }
                log.debug('Created grafana_tmp directory');
            }
        }
        try {
            if (!(0, node_fs_1.existsSync)(dashboardDir)) {
                await (0, fs_extra_1.ensureDir)(dashboardDir, desiredMode);
                log.debug('Created dashboard directory');
            }
            if (!(0, node_fs_1.existsSync)(folderDir)) {
                await (0, fs_extra_1.ensureDir)(folderDir, desiredMode);
                log.debug('Created folder directory');
            }
            if (!(0, node_fs_1.existsSync)(dashboardManuallyDir)) {
                await (0, fs_extra_1.ensureDir)(dashboardManuallyDir, desiredMode);
                log.debug('Created dashboards_manually_restore directory');
            }
            if (!(0, node_fs_1.existsSync)(datasourceDir)) {
                await (0, fs_extra_1.ensureDir)(datasourceDir, desiredMode);
                log.debug('Created datasource directory');
            }
        }
        catch (err) {
            options.context.errors.grafana = errText(err);
            log.error(`Grafana Backup cannot created: ${err}`);
            clearTimeout(timerLog);
            // Note: not cleared here, so a later callback can still fire - as before.
            cb?.(err);
        }
        if ((0, node_fs_1.existsSync)(tmpDir) &&
            (0, node_fs_1.existsSync)(datasourceDir) &&
            (0, node_fs_1.existsSync)(dashboardDir) &&
            (0, node_fs_1.existsSync)(dashboardManuallyDir)) {
            try {
                log.debug('start Grafana request ...');
                await getData(options, log, dashboardDir, folderDir, datasourceDir, dashboardManuallyDir, tmpDir, cb);
                log.debug('start Grafana backup compress ...');
                // compress Backup
                try {
                    const dashBoardFiles = await (0, promises_1.readdir)(dashboardDir);
                    const dataSourcesFiles = await (0, promises_1.readdir)(datasourceDir);
                    if (dataSourcesFiles.length !== 0 && dashBoardFiles.length !== 0) {
                        let nameSuffix;
                        if (options.hostType === 'Slave') {
                            nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
                        }
                        else {
                            nameSuffix = options.nameSuffix ? options.nameSuffix : '';
                        }
                        const fileName = (0, node_path_1.join)(options.backupDir, `grafana_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`);
                        options.context.fileNames.push(fileName);
                        waitCompress = setTimeout(() => (0, targz_1.compress)({
                            src: tmpDir,
                            dest: fileName,
                        }, async (err) => {
                            if (err) {
                                options.context.errors.grafana = err.toString();
                                clearTimeout(timerLog);
                                if (cb) {
                                    cb(err);
                                    clearTimeout(waitCompress);
                                }
                            }
                            else {
                                log.debug(`Backup created: ${fileName}`);
                                options.context.done.push('grafana');
                                options.context.types.push('grafana');
                                clearTimeout(timerLog);
                                if (cb) {
                                    try {
                                        await delTmp(options, tmpDir, log);
                                    }
                                    catch {
                                        log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
                                    }
                                    clearTimeout(timerLog);
                                    cb(null);
                                    cb = undefined;
                                    clearTimeout(waitCompress);
                                }
                            }
                        }), 5000);
                    }
                    else {
                        try {
                            await delTmp(options, tmpDir, log);
                        }
                        catch {
                            log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
                        }
                        log.error('cannot found Grafana Backup files');
                        clearTimeout(timerLog);
                        cb?.(null);
                        cb = undefined;
                        clearTimeout(waitCompress);
                    }
                }
                catch (e) {
                    options.context.errors.grafana = errText(e);
                    log.error(`Grafana Backup cannot created: ${e}`);
                    try {
                        await delTmp(options, tmpDir, log);
                    }
                    catch {
                        log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
                    }
                    clearTimeout(timerLog);
                    cb?.(null, e);
                    cb = undefined;
                    clearTimeout(waitCompress);
                }
            }
            catch (e) {
                try {
                    await delTmp(options, tmpDir, log);
                }
                catch {
                    log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
                }
                log.error(`Grafana Backup cannot created: ${e}`);
                clearTimeout(timerLog);
                cb?.(null, e);
                cb = undefined;
                clearTimeout(waitCompress);
            }
        }
        else {
            log.error('Grafana Backup cannot created ...');
            clearTimeout(timerLog);
            cb?.(null);
            cb = undefined;
            clearTimeout(waitCompress);
        }
    }
    else {
        options.context.errors.grafana = 'Grafana Backup cannot created. Please check your Configuration';
        log.error('Grafana Backup cannot created. Please check your Configuration');
        clearTimeout(timerLog);
        cb?.(null);
    }
}
async function delTmp(options, tmpDir, log) {
    log.debug(`Try deleting the Grafana tmp directory: "${tmpDir}"`);
    return (0, fs_extra_1.remove)(tmpDir)
        .then(() => {
        if (!(0, node_fs_1.existsSync)(tmpDir)) {
            log.debug(`Grafana tmp directory "${tmpDir}" successfully deleted`);
        }
    })
        .catch(err => {
        options.context.errors.grafana = errText(err);
        log.error(`The temporary directory "${tmpDir}" could not be deleted. Please check the directory permissions and delete the directory manually`);
        throw err;
    });
}
exports.ignoreErrors = true;
//# sourceMappingURL=36-grafana.js.map