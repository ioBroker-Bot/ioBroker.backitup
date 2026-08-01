/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */

import { existsSync, chmodSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import * as utils from '@iobroker/adapter-core'; // Get common adapter utils
import * as schedule from 'node-schedule';

import * as tools from './lib/tools';
import executeScripts from './lib/execute';
import * as systemCheck from './lib/systemCheck';
import TokenRefresher from './lib/tokenRefresher';

// Loaded on demand further down, so the adapter start stays cheap - only the types come in here.
import type * as ChildProcessModule from 'node:child_process';
import type * as HttpModule from 'node:http';
import type * as HttpsModule from 'node:https';
import type * as FsExtraModule from 'fs-extra';
import type { Express, RequestHandler } from 'express';


/** Call signature of lib/list, which is a CJS `export =` of a single function. */
type ListBackups = (
    restoreSource: BackItUpStorage | '' | undefined,
    config: Record<string, unknown>,
    log: ioBroker.Logger,
    callback?: (result: BackItUpListResult) => void,
) => void;

/** The slice of multer used below; the package is a CJS `export =` factory. */
type MulterFactory = ((options: { storage: unknown }) => {
    single(field: string): RequestHandler;
}) & {
    diskStorage(options: {
        destination: (req: unknown, file: { originalname: string }, cb: (e: null, dir: string) => void) => void;
        filename: (req: unknown, file: { originalname: string }, cb: (e: null, name: string) => void) => void;
    }): unknown;
};
import type GoogleDriveType from './lib/googleDriveLib';
import type OnedriveType from './lib/oneDriveLib';
import type * as RestoreModule from './lib/restore';
import type { BackItUpRestoreLogger } from './lib/restore/types';
import type { BackItUpExecuteConfig, BackItUpStorage } from './lib/types';
import type { BackItUpListResult, BackItUpStorageEngineResultFile } from './lib/list/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const adapterName: string = (require('./package.json') as { name: string }).name.split('.').pop()!;

// Assigned in startAdapter(), which every other function here runs after.
let adapter!: ioBroker.Adapter;

let timerOutput: NodeJS.Timeout | undefined;
let timerOutput2: NodeJS.Timeout | undefined;
let timerUmount1: NodeJS.Timeout | undefined;
let timerUmount2: NodeJS.Timeout | undefined;
let timerMain: NodeJS.Timeout | undefined;
let slaveTimeOut: NodeJS.Timeout | undefined;
let waitToSlaveBackup: NodeJS.Timeout | undefined;
let dlServer: (HttpModule.Server & { _connectionKey?: string }) | undefined;
let ulServer: (HttpModule.Server & { _connectionKey?: string }) | undefined;
let http: typeof HttpModule | undefined;
let https: typeof HttpsModule | undefined;

let systemLang = 'de'; // system language
const backupConfig: Record<string, any> = {};
/**
 * Keyed by backup type, not by index - the original initialised this as an array and only ever
 * addressed it with string keys. Kept as found.
 */
const backupTimeSchedules = [] as unknown as Record<string, schedule.Job | null>;
let taskRunning = false;
let dropBoxTokenRefresher: TokenRefresher | null = null;

const bashDir = join(utils.getAbsoluteDefaultDataDir(), adapterName).replace(/\\/g, '/');

/**
 * Decrypt the password/value with given key
 *
 * @param key - Secret key
 * @param value - value to decrypt
 */
function decrypt(key: string, value: string): string {
    let result = '';
    for (let i = 0; i < value.length; i++) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}

/**
 * Writes the current DropBox access token into every storage slice of the config.
 *
 * @param config the assembled backup config, mutated in place
 */
async function updateAccessTokens(config: Record<string, any>): Promise<void> {
    if (dropBoxTokenRefresher) {
        try {
            const accessToken = await dropBoxTokenRefresher.getAccessToken();

            Object.keys(config).forEach(key => {
                if (config[key] && typeof config[key] === 'object') {
                    if (config[key].dropbox) {
                        config[key].dropbox.accessToken = accessToken;
                    } else {
                        Object.keys(config[key]).forEach(subKey => {
                            if (config[key][subKey] && config[key][subKey].dropbox) {
                                config[key][subKey].dropbox.accessToken = accessToken;
                            }
                        });
                    }
                }
            });
        } catch (e) {
            adapter.log.error(`Cannot get access tokens for DropBox: ${e}`);
        }
    }
}

/**
 * Runs one backup, queueing behind a run that is still in progress.
 *
 * @param config the backup type's slice of the assembled config
 * @param cb reports the outcome
 */
async function startBackup(
    config: BackItUpExecuteConfig,
    cb?: (error?: Error | string | null) => void,
): Promise<void> {
    if (taskRunning) {
        setTimeout(startBackup, 10000, config, cb);
        return;
    }
    // await updateAccessTokens(config);

    taskRunning = true;
    try {
        executeScripts(adapter, config, err => {
            taskRunning = false;
            cb?.(err);
        });
        adapter.log.debug('Backup has started ...');
    } catch (e) {
        adapter.log.warn(`Backup error: ${(e as Error).stack}`);
        adapter.log.warn(`Backup error: ${e} ... please check your config and and try again!!`);
    }
}

/**
 * Writes the history states after a finished run and, for a master, kicks off the slave backups.
 *
 * @param type `'iobroker'` or `'ccu'`
 * @param onSuccess extra work once the run is confirmed successful
 * @param onFailure extra work once the run is confirmed failed
 */
function readRunResult(
    type: string,
    onSuccess?: (value: string) => void,
    onFailure?: (value: string | null) => void,
): void {
    void adapter.getState('output.line', (err, state) => {
        if (state && state.val === '[EXIT] 0') {
            void adapter.setState(`history.${type}Success`, true, true);
            void adapter.setState(`history.${type}LastTime`, tools.getTimeString(systemLang), true);
            onSuccess?.(state.val);
        } else {
            void adapter.setState(`history.${type}LastTime`, `error: ${tools.getTimeString(systemLang)}`, true);
            void adapter.setState(`history.${type}Success`, false, true);
            onFailure?.(state && state.val ? (state.val as string) : null);
        }
    });
}

function startAdapter(options?: Partial<utils.AdapterOptions>): ioBroker.Adapter {
    options = options || {};
    Object.assign(options, { name: adapterName });

    adapter = new utils.Adapter(options as utils.AdapterOptions);

    adapter.on('stateChange', async (id, state) => {
        dropBoxTokenRefresher?.onStateChange(id, state);

        if (id === `${adapter.namespace}.info.dropboxTokens`) {
            await updateAccessTokens(backupConfig);
            adapter.log.debug('Config Update for Dropbox Token');
        }

        if (state && (state.val === true || state.val === 'true') && !state.ack) {
            if (id === `${adapter.namespace}.oneClick.iobroker` || id === `${adapter.namespace}.oneClick.ccu`) {
                const sysCheck = await systemCheck.storageSizeCheck(adapter, adapterName, adapter.log);

                const type = id.split('.').pop()!;

                if ((sysCheck && sysCheck.ready && sysCheck.ready === true) || adapter.config.cifsEnabled === true) {
                    let config;
                    try {
                        config = JSON.parse(JSON.stringify(backupConfig[type]));
                        config.enabled = true;
                        config.deleteBackupAfter = 0; // do not delete files by custom backup
                    } catch (e) {
                        adapter.log.warn(`backup error: ${(e as Error).stack}`);
                        adapter.log.warn(`backup error: ${e} ... please check your config and try again!!`);
                    }

                    void startBackup(config, err => {
                        if (err) {
                            adapter.log.error(`[${type}] ${err}`);
                        } else {
                            adapter.log.debug(`[${type}] exec: done`);
                        }
                        timerOutput = setTimeout(() => {
                            readRunResult(type, () => {
                                if (adapter.config.onedriveEnabled && adapter.config.hostType === 'Single') {
                                    void renewOnedriveToken();
                                }
                            });
                        }, 500);
                        void adapter.setState(`oneClick.${type}`, false, true);

                        if (
                            adapter.config.slaveInstance &&
                            type === 'iobroker' &&
                            adapter.config.hostType === 'Master'
                        ) {
                            adapter.log.debug('Slave backup from BackItUp-Master is started ...');
                            void startSlaveBackup(adapter.config.slaveInstance[0], null);
                        }
                    });
                } else {
                    adapter.log.error(
                        `A local backup is currently not possible. The storage space is currently only ${sysCheck && sysCheck.diskFree ? sysCheck.diskFree : null} MB`,
                    );
                    systemCheck.systemMessage(
                        adapter,
                        tools._('A local backup is currently not possible. Please check your System!', systemLang),
                    );
                    void adapter.setState(`oneClick.${type}`, false, true);
                    void adapter.setState(
                        'output.line',
                        `[EXIT] ${tools._('A local backup is currently not possible. Please check your System!', systemLang)}`,
                        true,
                    );
                }
            }
        }
    });

    adapter.on('ready', async () => {
        try {
            await main(adapter);
        } catch {
            //ignore errors
        }
    });

    // is called when adapter shuts down - callback has to be called under any circumstances!
    adapter.on('unload', callback => {
        try {
            dropBoxTokenRefresher?.destroy();
            adapter.log.info('cleaned everything up...');
            clearTimeout(timerOutput2);
            clearTimeout(timerOutput);
            clearTimeout(timerUmount1);
            clearTimeout(timerUmount2);
            clearTimeout(timerMain);
            clearTimeout(slaveTimeOut);
            clearTimeout(waitToSlaveBackup);
            if (dlServer) {
                try {
                    dlServer.closeAllConnections();
                } catch (e) {
                    adapter.log.debug(`Download server Connections could not be closed: ${e}`);
                }
                try {
                    dlServer.close();
                } catch (e) {
                    adapter.log.debug(`Download server Connections could not be closed: ${e}`);
                }
            }
            if (ulServer) {
                try {
                    ulServer.closeAllConnections();
                } catch (e) {
                    adapter.log.debug(`Upload server connections could not be closed: ${e}`);
                }
                try {
                    ulServer.close();
                } catch (e) {
                    adapter.log.debug(`Upload server connections could not be closed: ${e}`);
                }
            }
        } catch (e) {
            console.log(`Cannot unload: ${e}`);
        }
        callback();
    });

    adapter.on('message', async obj => {
        if (obj) {
            switch (obj.command) {
                case 'list':
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const list = require('./lib/list') as ListBackups;
                        adapter.log.debug(`Reading backup list...`);
                        await updateAccessTokens(backupConfig);
                        list(obj.message, backupConfig, adapter.log, res => {
                            adapter.log.debug(`Backup list was read: ${JSON.stringify(res)}`);
                            if (obj.callback) {
                                adapter.sendTo(obj.from, obj.command, res, obj.callback);
                            }
                        });
                    } catch {
                        adapter.log.debug('Backup list cannot be read ...');
                    }
                    break;

                case 'authGoogleDrive': {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const GoogleDrive = require('./lib/googleDriveLib') as typeof GoogleDriveType;

                    if (obj.callback) {
                        const google = new GoogleDrive();
                        void google
                            .getAuthorizeUrl()
                            .then(url => adapter.sendTo(obj.from, obj.command, { url }, obj.callback));
                    }
                    break;
                }

                case 'authDropbox':
                    if (obj.callback) {
                        void TokenRefresher.getAuthUrl('https://oauth2.iobroker.in/dropbox').then(url =>
                            adapter.sendTo(obj.from, obj.command, { url }, obj.callback),
                        );
                    }
                    break;

                case 'authOnedrive': {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const Onedrive = require('./lib/oneDriveLib') as typeof OnedriveType;

                    if (obj.message && obj.message.code) {
                        const onedrive = new Onedrive();

                        void onedrive
                            .getRefreshToken(obj.message.code, adapter.log)
                            .then(json => adapter.sendTo(obj.from, obj.command, { done: true, json }, obj.callback))
                            .catch(err => adapter.sendTo(obj.from, obj.command, { error: err }, obj.callback));
                    } else if (obj.callback) {
                        const onedrive = new Onedrive();

                        void onedrive
                            .getAuthorizeUrl(adapter.log)
                            .then(url => adapter.sendTo(obj.from, obj.command, { url: url }, obj.callback))
                            .catch(err => adapter.sendTo(obj.from, obj.command, { error: err }, obj.callback));
                    }
                    break;
                }

                case 'restore':
                    if (obj.message) {
                        if (obj.message.stopIOB) {
                            await getCerts(obj.from);
                        }
                        adapter.log.info(`DATA: ${JSON.stringify(obj.message)}`);
                        await updateAccessTokens(backupConfig);

                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const _restore = require('./lib/restore') as typeof RestoreModule;
                        _restore.restore(
                            adapter,
                            backupConfig,
                            obj.message.type,
                            obj.message.fileName,
                            obj.message.currentTheme,
                            obj.message.currentProtocol,
                            bashDir,
                            adapter.log as unknown as BackItUpRestoreLogger,
                            res => obj.callback && adapter.sendTo(obj.from, obj.command, res, obj.callback),
                        );
                    } else if (obj.callback) {
                        invalidParameters(obj);
                    }
                    break;

                case 'uploadFile':
                    if (obj.message && obj.message.protocol) {
                        if (ulServer && ulServer._connectionKey && ulServer.listening) {
                            adapter.log.debug(`Upload server is running on Port ${serverPort(ulServer)}...`);
                        } else {
                            if (obj.message.protocol === 'https:') {
                                await getCerts(obj.from);
                            }

                            try {
                                ulFileServer(obj.message.protocol);
                            } catch {
                                adapter.log.debug('Upload server cannot started');
                            }
                        }

                        try {
                            adapter.sendTo(obj.from, obj.command, { listenPort: serverPort(ulServer!) }, obj.callback);
                        } catch (e) {
                            adapter.sendTo(obj.from, obj.command, { e }, obj.callback);
                        }
                    } else if (obj.callback) {
                        invalidParameters(obj);
                    }
                    break;

                case 'getFile':
                    if (obj.message && obj.message.type && obj.message.fileName && obj.message.protocol) {
                        if (dlServer && dlServer._connectionKey && dlServer.listening) {
                            adapter.log.debug(`Download server is running on port ${serverPort(dlServer)}...`);
                        } else {
                            if (obj.message.protocol === 'https:') {
                                await getCerts(obj.from);
                            }

                            try {
                                dlFileServer(obj.message.protocol);
                            } catch {
                                adapter.log.debug('Downloadserver cannot started');
                            }
                        }

                        const fileName = obj.message.fileName.split('/').pop();
                        if (obj.message.type !== 'local') {
                            const backupDir = join(tools.getIobDir(), 'backups');
                            const toSaveName = join(backupDir, fileName);

                            // eslint-disable-next-line @typescript-eslint/no-require-imports
                            const _getFile = require('./lib/restore') as typeof RestoreModule;
                            await updateAccessTokens(backupConfig);

                            _getFile.getFile(
                                backupConfig,
                                obj.message.type,
                                obj.message.fileName,
                                toSaveName,
                                adapter.log,
                                err => {
                                    if (!err && existsSync(toSaveName)) {
                                        try {
                                            adapter.sendTo(
                                                obj.from,
                                                obj.command,
                                                { fileName: fileName, listenPort: serverPort(dlServer!) },
                                                obj.callback,
                                            );
                                        } catch (error) {
                                            adapter.sendTo(obj.from, obj.command, { error }, obj.callback);
                                        }
                                    } else {
                                        adapter.log.warn(`File ${toSaveName} not found`);
                                    }
                                },
                            );
                        } else if (existsSync(obj.message.fileName)) {
                            try {
                                adapter.sendTo(
                                    obj.from,
                                    obj.command,
                                    { fileName: fileName, listenPort: serverPort(dlServer!) },
                                    obj.callback,
                                );
                            } catch (error) {
                                adapter.sendTo(obj.from, obj.command, { error }, obj.callback);
                            }
                        }
                    } else if (obj.callback) {
                        invalidParameters(obj);
                    }
                    break;

                case 'serverClose':
                    if (obj.message && obj.message.downloadFinish && !obj.message.uploadFinish) {
                        adapter.log.debug('Download finished...');
                        adapter.sendTo(obj.from, obj.command, { serverClose: true }, obj.callback);
                    } else if (obj.message && obj.message.uploadFinish && !obj.message.downloadFinish) {
                        adapter.log.debug('Upload finished...');
                        adapter.sendTo(obj.from, obj.command, { serverClose: true }, obj.callback);
                    } else if (obj.callback) {
                        invalidParameters(obj);
                    }
                    break;

                case 'getTelegramUser':
                    if (obj && obj.message) {
                        const inst = obj.message.config.instance
                            ? obj.message.config.instance
                            : adapter.config.telegramInstance;
                        void adapter.getForeignState(`${inst}.communicate.users`, (err, state) => {
                            if (err) {
                                adapter.log.error(err as unknown as string);
                            }
                            if (state && state.val) {
                                try {
                                    adapter.sendTo(obj.from, obj.command, state.val, obj.callback);
                                } catch (err) {
                                    if (err) {
                                        adapter.log.error(err as string);
                                    }
                                    adapter.log.error('Cannot parse stored user IDs from Telegram!');
                                }
                            }
                        });
                    }
                    break;

                case 'getSystemInfo':
                    if (obj) {
                        let systemInfo: string = process.platform;
                        let dbInfo = false;

                        if (existsSync('/opt/scripts/.docker_config/.thisisdocker')) {
                            // Docker Image Support >= 5.2.0

                            systemInfo = 'docker';

                            if (existsSync('/opt/scripts/.docker_config/.backitup')) {
                                dbInfo = true;
                            }
                        } else {
                            const isWin = process.platform.startsWith('win');

                            if (isWin) {
                                systemInfo = 'win';
                            }
                        }

                        try {
                            adapter.sendTo(
                                obj.from,
                                obj.command,
                                {
                                    systemOS: systemInfo,
                                    dockerDB: dbInfo,
                                    backupDir: join(tools.getIobDir(), 'backups'),
                                },
                                obj.callback,
                            );
                        } catch (err) {
                            if (err) {
                                adapter.log.error(err as string);
                            }
                        }
                    }
                    break;

                case 'getFileSystemInfo':
                    if (obj) {
                        const sysCheck = await systemCheck.storageSizeCheck(adapter, adapterName, adapter.log);

                        if (sysCheck) {
                            try {
                                adapter.sendTo(obj.from, obj.command, sysCheck, obj.callback);
                            } catch (err) {
                                if (err) {
                                    adapter.log.error(err as string);
                                }
                            }
                        }
                    }
                    break;

                case 'testWebDAV':
                    if (obj.message) {
                        // webdav is ESM only, so it has to be pulled in with a dynamic import
                        const { createClient } = await import('webdav');
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const agent = new (require('node:https') as typeof HttpsModule).Agent({
                            rejectUnauthorized: Boolean(obj.message.config.signedCertificates),
                        });

                        const client = createClient(obj.message.config.host, {
                            username: obj.message.config.username,
                            password: obj.message.config.password,
                            maxBodyLength: Infinity,
                            httpsAgent: agent,
                        });

                        void client
                            .getDirectoryContents('')
                            .then(
                                contents =>
                                    obj.callback && adapter.sendTo(obj.from, obj.command, contents, obj.callback),
                            )
                            .catch(err =>
                                adapter.sendTo(
                                    obj.from,
                                    obj.command,
                                    { error: JSON.stringify(err.message) },
                                    obj.callback,
                                ),
                            );
                    }
                    break;
                case 'slaveBackup':
                    if (obj?.message) {
                        if (adapter.config.hostType === 'Slave') {
                            adapter.log.debug('Slave Backup started ...');
                            const type = 'iobroker';
                            let config;
                            try {
                                config = JSON.parse(JSON.stringify(backupConfig[type]));
                                config.enabled = true;
                                // do delete files with specification from Master
                                config.deleteBackupAfter = obj.message.config.deleteAfter
                                    ? obj.message.config.deleteAfter
                                    : 0;
                            } catch (e) {
                                adapter.log.warn(`backup error: ${e} ... please check your config and try again!!`);
                            }
                            void startBackup(config, err => {
                                if (err) {
                                    adapter.log.error(`[${type}] ${err}`);
                                } else {
                                    adapter.log.debug(`[${type}] exec: done`);
                                }
                                const reply = (value: string | null): void => {
                                    if (value === null) {
                                        return;
                                    }
                                    try {
                                        adapter.sendTo(obj.from, obj.command, value, obj.callback);
                                    } catch (err) {
                                        if (err) {
                                            adapter.log.error(err as string);
                                        }
                                        adapter.log.error('slave Backup not finish!');
                                    }
                                };
                                timerOutput = setTimeout(
                                    () =>
                                        readRunResult(
                                            type,
                                            value => {
                                                reply(value);
                                                if (adapter.config.onedriveEnabled) {
                                                    void renewOnedriveToken();
                                                }
                                            },
                                            reply,
                                        ),
                                    500,
                                );
                                void adapter.setState(`oneClick.${type}`, false, true);
                            });
                        } else {
                            adapter.log.warn('Your BackItUp Instance is not configured as a slave');
                            adapter.sendTo(obj.from, obj.command, 'not configured as a slave', obj.callback);
                        }
                    }
                    break;
                case 'slaveInstance':
                    if (obj && obj.command === 'slaveInstance' && obj.message && obj.message.instance) {
                        const resultInstances: { label: string; value: string }[] = [];

                        const instances = await adapter
                            .getObjectViewAsync('system', 'instance', {
                                startkey: `system.adapter.${obj.message.instance}.`,
                                endkey: `system.adapter.${obj.message.instance}.\u9999`,
                            })
                            .catch(err => adapter.log.error(err));

                        if (instances && instances.rows && instances.rows.length != 0) {
                            instances.rows.forEach(row => {
                                if (row.id.replace('system.adapter.', '') != adapter.namespace) {
                                    resultInstances.push({
                                        label: row.id.replace('system.adapter.', ''),
                                        value: row.id.replace('system.adapter.', ''),
                                    });
                                }
                            });
                        }

                        adapter.sendTo(obj.from, obj.command, resultInstances, obj.callback);
                    }
                    break;
                case 'getLog': {
                    const logName = join(bashDir, `${adapter.namespace}.log`).replace(/\\/g, '/');

                    if (existsSync(logName) && (obj?.message.backupName || obj?.message.timestamp)) {
                        const data = readFileSync(logName, 'utf8');
                        const backupLog = JSON.parse(data);
                        const backupName = obj?.message.backupName ? obj.message.backupName : null;
                        const timestamp = obj?.message.timestamp;
                        let found = false;

                        backupLog.forEach((item: Record<string, string>, index: number) => {
                            if (Object.prototype.hasOwnProperty.call(item, timestamp)) {
                                found = true;
                                adapter.log.debug(`Printing logs of previous backup`);
                                adapter.sendTo(obj.from, obj.command, item[timestamp], obj.callback);
                            } else if (backupName !== null && Object.prototype.hasOwnProperty.call(item, backupName)) {
                                found = true;
                                adapter.log.debug(`Printing logs of previous backup`);
                                adapter.sendTo(obj.from, obj.command, item[backupName], obj.callback);
                            } else if (backupLog.length - 1 == index && !found) {
                                adapter.log.debug(`No Backuplogs found`);
                                adapter.sendTo(
                                    obj.from,
                                    obj.command,
                                    tools._('No log is available for this backup', systemLang),
                                    obj.callback,
                                );
                            }
                        });
                    }
                    break;
                }
            }
        }
    });

    return adapter;
}

/**
 * Rejects a message that arrived without the parameters its command needs.
 *
 * NOTE: `obj.callback` is the `{ message, id, ack, time }` descriptor js-controller attaches, not a
 * function, so this throws "obj.callback is not a function" out of the async message handler and
 * the caller never gets an answer. Kept as found - the reply would have to go through
 * `adapter.sendTo(obj.from, obj.command, ..., obj.callback)` like every other branch does.
 *
 * @param obj the incoming message
 */
function invalidParameters(obj: ioBroker.Message): void {
    (obj.callback as unknown as (response: unknown) => void)({ error: 'Invalid parameters' });
}

/**
 * Reads the listen port of a running server; both are bound to a TCP address.
 *
 * @param server the listening http/https server
 */
function serverPort(server: HttpModule.Server): number {
    return (server.address() as { port: number }).port;
}

async function checkStates(): Promise<void> {
    // Fill empty data points with default values
    const historyState = await adapter.getStateAsync('history.html');
    if (!historyState || historyState.val === null) {
        await adapter.setStateAsync('history.html', {
            val: `<span class="backup-type-total">${tools._('No backups yet', systemLang)}</span>`,
            ack: true,
        });
    }

    const iobrokerLastTime = await adapter.getStateAsync('history.iobrokerLastTime');
    if (!iobrokerLastTime || iobrokerLastTime.val === null) {
        await adapter.setStateAsync('history.iobrokerLastTime', {
            val: tools._('No backups yet', systemLang),
            ack: true,
        });
    }

    const ccuLastTime = await adapter.getStateAsync('history.ccuLastTime');
    if (!ccuLastTime || ccuLastTime.val === null) {
        await adapter.setStateAsync('history.ccuLastTime', { val: tools._('No backups yet', systemLang), ack: true });
    }

    const iobrokerState = await adapter.getStateAsync('oneClick.iobroker');
    if (!iobrokerState || iobrokerState.val === null || iobrokerState.val === true) {
        await adapter.setStateAsync('oneClick.iobroker', { val: false, ack: true });
    }

    const ccuState = await adapter.getStateAsync('oneClick.ccu');
    if (!ccuState || ccuState.val === null || ccuState.val === true) {
        await adapter.setStateAsync('oneClick.ccu', { val: false, ack: true });
    }

    const ccuSuccess = await adapter.getStateAsync('history.ccuSuccess');
    if (!ccuSuccess || ccuSuccess.val === null) {
        await adapter.setStateAsync('history.ccuSuccess', { val: false, ack: true });
    }

    const iobrokerSuccess = await adapter.getStateAsync('history.iobrokerSuccess');
    if (!iobrokerSuccess || iobrokerSuccess.val === null) {
        await adapter.setStateAsync('history.iobrokerSuccess', { val: false, ack: true });
    }

    const jsonState = await adapter.getStateAsync('history.json');
    if (!jsonState || jsonState.val === null) {
        await adapter.setStateAsync('history.json', { val: '[]', ack: true });
    }
}

// function to create Backup schedules (Backup time)
function createBackupSchedule(): void {
    for (const type in backupConfig) {
        if (!Object.prototype.hasOwnProperty.call(backupConfig, type)) {
            continue;
        }

        const config = backupConfig[type];
        if (config.enabled === true || config.enabled === 'true') {
            const time = config.ownCron ? config.cronjob : config.time.split(':');

            const backupInfo = config.ownCron
                ? `with Cronjob "${config.cronjob}"`
                : `at ${config.time} every ${config.everyXDays} day(s)`;
            adapter.log.info(`[${type}] backup will be activated ${backupInfo}`);

            if (backupTimeSchedules[type]) {
                backupTimeSchedules[type].cancel();
            }
            const cron = config.ownCron ? time : `10 ${time[1]} ${time[0]} */${config.everyXDays} * * `;
            backupTimeSchedules[type] = schedule.scheduleJob(cron, async () => {
                const sysCheck = await systemCheck.storageSizeCheck(adapter, adapterName, adapter.log);

                if ((sysCheck && sysCheck.ready && sysCheck.ready === true) || adapter.config.cifsEnabled === true) {
                    void adapter.setState(`oneClick.${type}`, true, true);

                    void startBackup(backupConfig[type], err => {
                        if (err) {
                            adapter.log.error(`[${type}] ${err}`);
                        } else {
                            adapter.log.debug(`[${type}] exec: done`);
                        }
                        timerOutput2 = setTimeout(
                            () =>
                                readRunResult(type, () => {
                                    if (adapter.config.onedriveEnabled && adapter.config.hostType === 'Single') {
                                        void renewOnedriveToken();
                                    }
                                }),
                            500,
                        );
                        void nextBackup(false, type);
                        void adapter.setState(`oneClick.${type}`, false, true);

                        if (
                            adapter.config.slaveInstance &&
                            type === 'iobroker' &&
                            adapter.config.hostType === 'Master'
                        ) {
                            adapter.log.debug('Slave backup from BackItUp-Master is started ...');
                            void startSlaveBackup(adapter.config.slaveInstance[0], null);
                        }
                    });
                } else {
                    adapter.log.error(
                        `A local backup is currently not possible. The storage space is currently only ${sysCheck && sysCheck.diskFree ? sysCheck.diskFree : null} MB`,
                    );
                    systemCheck.systemMessage(
                        adapter,
                        tools._('A local backup is currently not possible. Please check your System!', systemLang),
                    );
                }
            });

            if (config.debugging) {
                adapter.log.debug(`[${type}] ${cron}`);
            }
        } else if (backupTimeSchedules[type]) {
            adapter.log.info(`[${type}] backup deactivated`);
            backupTimeSchedules[type].cancel();
            backupTimeSchedules[type] = null;
        }
    }
}

/**
 * Builds `backupConfig` from the instance configuration.
 *
 * @param secret the system secret the stored passwords were encrypted with
 */
async function initConfig(secret: string): Promise<void> {
    // compatibility
    if (adapter.config.cifsMount === 'CIFS') {
        adapter.config.cifsMount = '';
    }
    if (adapter.config.redisEnabled === undefined) {
        adapter.config.redisEnabled = adapter.config.backupRedis!;
    }
    let ioPath;

    try {
        // ioPath = `${ioCommon.tools.getControllerDir()}/iobroker.js`; Todo: Error by iob Backup (no such file or directory, uv_cwd)
        // ioPath = require.resolve('iobroker.js-controller/iobroker.js');
        // Two levels up: this file compiles to build/main.js, so `__dirname` is
        // <adapter>/build and the sibling adapters live one directory above that.
        ioPath = resolvePath(__dirname, '../../iobroker.js-controller/iobroker.js');
    } catch (e) {
        adapter.log.error(`Unable to read iobroker path: +${e}`);
    }

    decryptEvents(secret);

    const hostName = adapter.config.minimalNameSuffix
        ? adapter.config.minimalNameSuffix.replace(/[.;, ]/g, '_')
        : '';
    const ignoreErrors = adapter.config.ignoreErrors;
    const notificationsType = adapter.config.notificationsType;
    const notificationEnabled = adapter.config.notificationEnabled;

    const telegram = {
        enabled: notificationEnabled,
        notificationsType,
        type: 'message',
        instance: adapter.config.telegramInstance,
        SilentNotice: adapter.config.telegramSilentNotice,
        NoticeType: adapter.config.telegramNoticeType,
        User: adapter.config.telegramUser,
        onlyError: adapter.config.telegramOnlyError,
        telegramWaiting: adapter.config.telegramWaitToSend * 1000,
        hostName,
        ignoreErrors,
        systemLang,
    };

    const whatsapp = {
        enabled: notificationEnabled,
        notificationsType,
        type: 'message',
        instance: adapter.config.whatsappInstance,
        NoticeType: adapter.config.whatsappNoticeType,
        onlyError: adapter.config.whatsappOnlyError,
        whatsappWaiting: adapter.config.whatsappWaitToSend * 1000,
        hostName,
        ignoreErrors,
        systemLang,
    };

    const gotify = {
        enabled: notificationEnabled,
        notificationsType,
        type: 'message',
        instance: adapter.config.gotifyInstance,
        NoticeType: adapter.config.gotifyNoticeType,
        onlyError: adapter.config.gotifyOnlyError,
        gotifyWaiting: adapter.config.gotifyWaitToSend * 1000,
        hostName,
        ignoreErrors,
        systemLang,
    };

    const signal = {
        enabled: notificationEnabled,
        notificationsType,
        type: 'message',
        instance: adapter.config.signalInstance,
        NoticeType: adapter.config.signalNoticeType,
        onlyError: adapter.config.signalOnlyError,
        signalWaiting: adapter.config.signalWaitToSend * 1000,
        hostName,
        ignoreErrors,
        systemLang,
    };

    const matrix = {
        enabled: notificationEnabled,
        notificationsType,
        type: 'message',
        instance: adapter.config.matrixInstance,
        NoticeType: adapter.config.matrixNoticeType,
        onlyError: adapter.config.matrixOnlyError,
        matrixWaiting: adapter.config.matrixWaitToSend * 1000,
        hostName,
        ignoreErrors,
        systemLang,
    };

    const discord = {
        enabled: notificationEnabled,
        notificationsType,
        type: 'message',
        instance: adapter.config.discordInstance,
        NoticeType: adapter.config.discordNoticeType,
        target: adapter.config.discordTarget,
        onlyError: adapter.config.discordOnlyError,
        discordWaiting: adapter.config.discordWaitToSend * 1000,
        hostName,
        ignoreErrors,
        systemLang,
    };

    const pushover = {
        enabled: notificationEnabled,
        notificationsType,
        type: 'message',
        instance: adapter.config.pushoverInstance,
        SilentNotice: adapter.config.pushoverSilentNotice,
        NoticeType: adapter.config.pushoverNoticeType,
        deviceID: adapter.config.pushoverDeviceID,
        onlyError: adapter.config.pushoverOnlyError,
        pushoverWaiting: adapter.config.pushoverWaitToSend * 1000,
        hostName,
        ignoreErrors,
        systemLang,
    };

    const email = {
        enabled: notificationEnabled,
        notificationsType,
        type: 'message',
        instance: adapter.config.emailInstance,
        NoticeType: adapter.config.emailNoticeType,
        emailReceiver: adapter.config.emailReceiver,
        emailSender: adapter.config.emailSender,
        onlyError: adapter.config.emailOnlyError,
        emailWaiting: adapter.config.emailWaitToSend * 1000,
        hostName,
        ignoreErrors,
        systemLang,
    };

    const notification = {
        type: 'message',
        ignoreErrors,
        bashDir: bashDir,
        entriesNumber: adapter.config.historyEntriesNumber,
        systemLang,
    };

    const historyHTML = {
        enabled: true,
        type: 'message',
        entriesNumber: adapter.config.historyEntriesNumber,
        ignoreErrors,
        systemLang,
    };

    const historyJSON = {
        enabled: true,
        type: 'message',
        entriesNumber: adapter.config.historyEntriesNumber,
        ignoreErrors,
        systemLang,
    };

    const ftp = {
        enabled: adapter.config.ftpEnabled,
        type: 'storage',
        source: adapter.config.restoreSource,
        host: adapter.config.ftpHost, // ftp-host
        debugging: adapter.config.debugLevel,
        deleteOldBackup: adapter.config.ftpDeleteOldBackup, // Delete old Backups from FTP
        ftpDeleteAfter: adapter.config.ftpDeleteAfter,
        advancedDelete: adapter.config.advancedDelete,
        ownDir: adapter.config.ftpOwnDir,
        bkpType: adapter.config.restoreType,
        dir: adapter.config.ftpOwnDir === true ? null : adapter.config.ftpDir, // directory on FTP server
        dirMinimal: adapter.config.ftpMinimalDir,
        user: adapter.config.ftpUser, // username for FTP Server
        pass: adapter.config.ftpPassword || '', // password for FTP Server
        port: adapter.config.ftpPort || 21, // FTP port
        secure: adapter.config.ftpSecure || false, // secure FTP connection
        signedCertificates: adapter.config.ftpSignedCertificates || true,
        ignoreErrors,
    };

    let accessToken: string | undefined = '';
    if (adapter.config.dropboxEnabled) {
        dropBoxTokenRefresher = new TokenRefresher(adapter, 'info.dropboxTokens', 'https://oauth2.iobroker.in/dropbox');
        try {
            accessToken = await dropBoxTokenRefresher.getAccessToken();
        } catch (e) {
            adapter.log.error(`No DropBox token found: ${e}`);
        }
    }

    const dropbox = {
        enabled: adapter.config.dropboxEnabled,
        type: 'storage',
        source: adapter.config.restoreSource,
        debugging: adapter.config.debugLevel,
        deleteOldBackup: adapter.config.dropboxDeleteOldBackup, // Delete old Backups from Dropbox
        dropboxDeleteAfter: adapter.config.dropboxDeleteAfter,
        advancedDelete: adapter.config.advancedDelete,
        accessToken: adapter.config.dropboxTokenType === 'custom' ? adapter.config.dropboxAccessToken : accessToken,
        dropboxAccessJson: adapter.config.dropboxAccessJson,
        dropboxTokenType: adapter.config.dropboxTokenType,
        ownDir: adapter.config.dropboxOwnDir,
        bkpType: adapter.config.restoreType,
        dir: adapter.config.dropboxOwnDir === true ? null : adapter.config.dropboxDir,
        dirMinimal: adapter.config.dropboxMinimalDir,
        ignoreErrors,
    };

    const onedrive = {
        enabled: adapter.config.onedriveEnabled,
        type: 'storage',
        source: adapter.config.restoreSource,
        debugging: adapter.config.debugLevel,
        deleteOldBackup: adapter.config.onedriveDeleteOldBackup, // Delete old Backups from Onedrive
        onedriveDeleteAfter: adapter.config.onedriveDeleteAfter,
        advancedDelete: adapter.config.advancedDelete,
        onedriveAccessJson: adapter.config.onedriveAccessJson,
        ownDir: adapter.config.onedriveOwnDir,
        bkpType: adapter.config.restoreType,
        dir: adapter.config.onedriveOwnDir === true ? null : adapter.config.onedriveDir,
        dirMinimal: adapter.config.onedriveMinimalDir,
        ignoreErrors,
    };

    const webdav = {
        enabled: adapter.config.webdavEnabled,
        type: 'storage',
        source: adapter.config.restoreSource,
        debugging: adapter.config.debugLevel,
        deleteOldBackup: adapter.config.webdavDeleteOldBackup, // Delete old Backups from webdav
        webdavDeleteAfter: adapter.config.webdavDeleteAfter,
        advancedDelete: adapter.config.advancedDelete,
        username: adapter.config.webdavUsername,
        pass: adapter.config.webdavPassword || '', // webdav password
        url: adapter.config.webdavURL,
        ownDir: adapter.config.webdavOwnDir,
        bkpType: adapter.config.restoreType,
        dir: adapter.config.webdavOwnDir === true ? null : adapter.config.webdavDir,
        dirMinimal: adapter.config.webdavMinimalDir,
        signedCertificates: adapter.config.webdavSignedCertificates,
        ignoreErrors,
    };

    const googledrive = {
        enabled: adapter.config.googledriveEnabled,
        type: 'storage',
        source: adapter.config.restoreSource,
        debugging: adapter.config.debugLevel,
        deleteOldBackup: adapter.config.googledriveDeleteOldBackup, // Delete old Backups from google drive
        googledriveDeleteAfter: adapter.config.googledriveDeleteAfter,
        advancedDelete: adapter.config.advancedDelete,
        accessJson: adapter.config.googledriveAccessTokens || adapter.config.googledriveAccessJson,
        newToken: !!adapter.config.googledriveAccessTokens,
        ownDir: adapter.config.googledriveOwnDir,
        bkpType: adapter.config.restoreType,
        dir: adapter.config.googledriveOwnDir === true ? null : adapter.config.googledriveDir,
        dirMinimal: adapter.config.googledriveMinimalDir,
        ignoreErrors,
    };

    const cifs = {
        enabled: adapter.config.cifsEnabled,
        mountType: adapter.config.connectType,
        type: 'storage',
        source: adapter.config.restoreSource,
        mount: adapter.config.cifsMount,
        debugging: adapter.config.debugLevel,
        fileDir: bashDir,
        wakeOnLAN: adapter.config.wakeOnLAN,
        macAd: adapter.config.macAd,
        wolTime: adapter.config.wolWait,
        wolPort: adapter.config.wolPort || 9,
        wolExtra: adapter.config.wolExtra,
        smb: adapter.config.smbType,
        sudo: adapter.config.sudoMount,
        cifsDomain: adapter.config.cifsDomain,
        clientInodes: adapter.config.noserverino,
        cacheLoose: adapter.config.cacheLoose,
        deleteOldBackup: adapter.config.cifsDeleteOldBackup, //Delete old Backups from Network Disk
        ownDir: adapter.config.cifsOwnDir,
        bkpType: adapter.config.restoreType,
        dir: adapter.config.cifsOwnDir === true ? null : adapter.config.cifsDir, // specify if CIFS mount should be used
        dirMinimal: adapter.config.cifsMinimalDir,
        user: adapter.config.cifsUser, // specify if CIFS mount should be used
        pass: adapter.config.cifsPassword || '', // password for NAS Server
        expertMount: adapter.config.expertMount,
        ignoreErrors,
    };

    /**
     * Every backup slice carries its own copy of the six storage configs, with the target directory
     * swapped for the per-backup-type one when "own directory" is on. The original spelled these six
     * `Object.assign` lines out at each of the sixteen slices.
     *
     * Must be called per slice - each slice needs its own copies.
     *
     * @param variant which set of per-type directories to use
     */
    const storagesFor = (variant: 'Minimal' | 'Ccu'): Record<string, any> => ({
        ftp: Object.assign(
            {},
            ftp,
            adapter.config.ftpOwnDir === true ? { dir: adapter.config[`ftp${variant}Dir`] } : {},
        ),
        cifs: Object.assign(
            {},
            cifs,
            adapter.config.cifsOwnDir === true ? { dir: adapter.config[`cifs${variant}Dir`] } : {},
        ),
        dropbox: Object.assign(
            {},
            dropbox,
            adapter.config.dropboxOwnDir === true ? { dir: adapter.config[`dropbox${variant}Dir`] } : {},
        ),
        onedrive: Object.assign(
            {},
            onedrive,
            adapter.config.onedriveOwnDir === true ? { dir: adapter.config[`onedrive${variant}Dir`] } : {},
        ),
        webdav: Object.assign(
            {},
            webdav,
            adapter.config.webdavOwnDir === true ? { dir: adapter.config[`webdav${variant}Dir`] } : {},
        ),
        googledrive: Object.assign(
            {},
            googledrive,
            adapter.config.googledriveOwnDir === true ? { dir: adapter.config[`googledrive${variant}Dir`] } : {},
        ),
    });

    // names addition, appended to the file name
    const nameSuffix = adapter.config.minimalNameSuffix.replace(/[.;, ]/g, '_');
    const slaveSuffix = adapter.config.hostType === 'Slave' ? adapter.config.slaveNameSuffix : '';
    const hostType = adapter.config.hostType;
    const iobDataDir = join(tools.getIobDir(), 'iobroker-data');

    // Configurations for standard-IoBroker backup
    backupConfig.iobroker = {
        name: 'iobroker',
        type: 'creator',
        workDir: ioPath,
        enabled: adapter.config.minimalEnabled,
        time: adapter.config.minimalTime,
        cronjob: adapter.config.iobrokerCronJob,
        ownCron: adapter.config.iobrokerCron,
        debugging: adapter.config.debugLevel,
        slaveBackup: adapter.config.hostType,
        everyXDays: adapter.config.minimalEveryXDays,
        nameSuffix,
        deleteBackupAfter: adapter.config.minimalDeleteAfter, // delete old backup files after x days
        ...storagesFor('Minimal'),
        ignoreErrors,
        mysql: {
            enabled: adapter.config.mySqlEnabled === undefined ? true : adapter.config.mySqlEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            nameSuffix,
            mysqlQuick: adapter.config.mysqlQuick,
            slaveSuffix,
            hostType,
            mysqlSingleTransaction: adapter.config.mysqlSingleTransaction,
            dbName: adapter.config.mySqlName, // database name
            user: adapter.config.mySqlUser, // database user
            pass: adapter.config.mySqlPassword || '', // database password
            deleteBackupAfter: adapter.config.mySqlDeleteAfter, // delete old backupfiles after x days
            host: adapter.config.mySqlHost, // database host
            port: adapter.config.mySqlPort, // database port
            mySqlEvents: adapter.config.mySqlEvents,
            mySqlMulti: adapter.config.mySqlMulti,
            ignoreErrors,
            skipSSL: adapter.config.mysqlSkipSSL,
            exe: adapter.config.mySqlDumpExe, // path to mysqldump
        },
        sqlite: {
            enabled: adapter.config.sqliteEnabled === undefined ? true : adapter.config.sqliteEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            nameSuffix,
            slaveSuffix,
            hostType,
            deleteBackupAfter: adapter.config.sqliteDeleteAfter, // delete old backupfiles after x days
            ignoreErrors,
            filePth: adapter.config.sqlitePath,
            exe: adapter.config.sqliteDumpExe, // path to sqlitedump
        },
        dir: tools.getIobDir(),
        influxDB: {
            enabled: adapter.config.influxDBEnabled === undefined ? true : adapter.config.influxDBEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            nameSuffix,
            slaveSuffix,
            hostType,
            deleteBackupAfter: adapter.config.influxDBDeleteAfter, // delete old backupfiles after x days
            dbName: adapter.config.influxDBName, // database name
            host: adapter.config.influxDBHost, // database host
            port: adapter.config.influxDBPort
                ? adapter.config.influxDBPort
                : adapter.config.influxDBVersion == '1.x'
                  ? 8088
                  : 8086,
            dbversion: adapter.config.influxDBVersion, // dbversion from Influxdb
            token: adapter.config.influxDBToken, // Token from Influxdb
            protocol: adapter.config.influxDBProtocol, // Protocol Type from Influxdb
            exe: adapter.config.influxDBDumpExe, // path to influxDBdump
            dbType: adapter.config.influxDBType, // type of influxdb Backup
            influxDBEvents: adapter.config.influxDBEvents,
            influxDBMulti: adapter.config.influxDBMulti,
            ignoreErrors,
            deleteDataBase: adapter.config.deleteOldDataBase, // delete old database for restore
        },
        pgsql: {
            enabled: adapter.config.pgSqlEnabled === undefined ? true : adapter.config.pgSqlEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            nameSuffix,
            slaveSuffix,
            hostType,
            dbName: adapter.config.pgSqlName, // database name
            user: adapter.config.pgSqlUser, // database user
            pass: adapter.config.pgSqlPassword || '', // database password
            deleteBackupAfter: adapter.config.pgSqlDeleteAfter, // delete old backupfiles after x days
            host: adapter.config.pgSqlHost, // database host
            port: adapter.config.pgSqlPort, // database port
            pgSqlEvents: adapter.config.pgSqlEvents,
            pgSqlMulti: adapter.config.pgSqlMulti,
            ignoreErrors,
            exe: adapter.config.pgSqlDumpExe, // path to mysqldump
        },
        redis: {
            enabled: adapter.config.redisEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            aof: adapter.config.redisAOFactive,
            nameSuffix,
            slaveSuffix,
            hostType,
            path: adapter.config.redisPath || '/var/lib/redis', // specify Redis path
            redisType: adapter.config.redisType, // local or Remote Backup
            host: adapter.config.redisHost, // Host for Remote Backup
            port: adapter.config.redisPort, // Port for Remote Backup
            user: adapter.config.redisUser, // User for Remote Backup
            pass: adapter.config.redisPassword || '', // Password for Remote Backup
            ignoreErrors,
        },
        historyDB: {
            enabled: adapter.config.historyEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            path: adapter.config.historyPath,
            nameSuffix,
            slaveSuffix,
            hostType,
            ignoreErrors,
        },
        zigbee: {
            enabled: adapter.config.zigbeeEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            path: iobDataDir, // specify zigbee path
            nameSuffix,
            slaveSuffix,
            hostType,
            ignoreErrors,
        },
        esphome: {
            enabled: adapter.config.esphomeEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            path: iobDataDir, // specify esphome path
            nameSuffix,
            slaveSuffix,
            hostType,
            ignoreErrors,
        },
        zigbee2mqtt: {
            enabled: adapter.config.zigbee2mqttEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            path: adapter.config.zigbee2mqttPath, // specify zigbee2mqtt path
            z2mType: adapter.config.zigbee2mqttType,
            z2mUsername: adapter.config.zigbee2mqttUser,
            z2mPassword: adapter.config.zigbee2mqttPassword,
            z2mUrl: adapter.config.zigbee2mqttHost,
            z2mPort: adapter.config.zigbee2mqttPort,
            z2mBaseTopic: adapter.config.zigbee2mqttBaseTopic,
            z2mAuth: adapter.config.zigbee2mqttAuth,
            nameSuffix,
            slaveSuffix,
            hostType,
            ignoreErrors,
        },
        nodered: {
            enabled: adapter.config.noderedEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            path: iobDataDir, // specify Node-Red path
            nameSuffix,
            slaveSuffix,
            hostType,
            ignoreErrors,
        },
        yahka: {
            enabled: adapter.config.yahkaEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            path: iobDataDir, // specify yahka path
            nameSuffix,
            slaveSuffix,
            hostType,
            ignoreErrors,
        },
        jarvis: {
            enabled: adapter.config.jarvisEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            path: iobDataDir, // specify jarvis backup path
            nameSuffix,
            slaveSuffix,
            hostType,
            ignoreErrors,
        },
        javascripts: {
            enabled: adapter.config.javascriptsEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            slaveSuffix,
            hostType,
            nameSuffix,
            ignoreErrors,
        },
        grafana: {
            enabled: adapter.config.grafanaEnabled,
            type: 'creator',
            ...storagesFor('Minimal'),
            host: adapter.config.grafanaHost, // database host
            port: adapter.config.grafanaPort, // database port
            protocol: adapter.config.grafanaProtocol, // database protocol
            apiKey: adapter.config.grafanaApiKey,
            nameSuffix,
            slaveSuffix,
            hostType,
            ignoreErrors,
            signedCertificates:
                adapter.config.grafanaProtocol == 'https' ? adapter.config.grafanaSignedCertificates : true,
        },
        historyHTML,
        historyJSON,
        telegram,
        email,
        pushover,
        whatsapp,
        gotify,
        signal,
        matrix,
        discord,
        notification,
    };

    // Configurations for CCU / pivCCU / RaspberryMatic backup
    backupConfig.ccu = {
        name: 'ccu',
        type: 'creator',
        enabled: adapter.config.ccuEnabled,
        time: adapter.config.ccuTime,
        cronjob: adapter.config.ccuCronJob,
        ownCron: adapter.config.ccuCron,
        debugging: adapter.config.debugLevel,
        everyXDays: adapter.config.ccuEveryXDays,
        nameSuffix: adapter.config.ccuNameSuffix, // names addition, appended to the file name
        deleteBackupAfter: adapter.config.ccuDeleteAfter, // delete old backupfiles after x days
        signedCertificates: adapter.config.ccuSignedCertificates,
        ignoreErrors,

        ...storagesFor('Ccu'),
        historyHTML,
        historyJSON,
        telegram,
        email,
        pushover,
        whatsapp,
        gotify,
        signal,
        matrix,
        discord,
        notification,

        host: adapter.config.ccuHost, // IP-address CCU
        user: adapter.config.ccuUser, // username CCU
        usehttps: adapter.config.ccuUsehttps, // Use https for CCU Connect
        pass: adapter.config.ccuPassword || '', // password der CCU
        ccuEvents: adapter.config.ccuEvents,
        ccuMulti: adapter.config.ccuMulti,
    };
}

function readLogFile(): void {
    try {
        const logName = join(tools.getIobDir(), 'backups', 'logs.txt').replace(/\\/g, '/');
        if (existsSync(logName)) {
            adapter.log.debug(`Printing logs of previous backup`);
            const text = readFileSync(logName).toString();
            const lines = text.split('\n');
            lines.forEach((line, i) => (lines[i] = line.replace(/\r$|^\r/, '')));
            lines.forEach(line => {
                line = line.trim();

                if (line) {
                    if (line.startsWith('[ERROR]')) {
                        adapter.log.error(line);
                    } else {
                        adapter.log.debug(line);
                    }
                    void adapter.setState('output.line', line, true);
                }
            });
            void adapter.setState('output.line', '[EXIT] 0', true);
            unlinkSync(logName);
        }
    } catch (e) {
        adapter.log.warn(`Cannot read log file: ${e}`);
    }
}

function createBashScripts(): void {
    const isWin = process.platform.startsWith('win');
    if (!existsSync(bashDir)) {
        mkdirSync(bashDir);
        adapter.log.debug('BackItUp data-directory created');
    }
    const logFile = join(bashDir, `${adapter.namespace}.log`);
    if (!existsSync(logFile)) {
        writeFileSync(logFile, '[]');
    }
    if (isWin) {
        adapter.log.debug(`BackItUp has recognized a ${process.platform} system`);

        try {
            writeFileSync(`${bashDir}/stopIOB.bat`, `start "" "${join(bashDir, 'external.bat')}"`);
        } catch (e) {
            adapter.log.error(`cannot create stopIOB.bat: ${e}Please run "iobroker fix"`);
        }

        try {
            writeFileSync(
                `${bashDir}/external.bat`,
                `cd "${join(tools.getIobDir())}"\ncall iobroker stop\ntimeout /T 15\nif exist "${join(bashDir, '.redis.info')}" (\nredis-server --service-stop\n)\nif exist "${join(bashDir, '.redis.info')}" (\ncd "${join(__dirname, 'lib')}"\n) else (\ncd "${join(bashDir)}"\n)\nnode restore.js`,
            );
            chmodSync(`${bashDir}/external.bat`, 508);
        } catch (e) {
            adapter.log.error(`cannot create external.sh: ${e}Please run "iobroker fix"`);
        }

        try {
            writeFileSync(
                `${bashDir}/startIOB.bat`,
                `if exist "${join(bashDir, '.redis.info')}" (\nredis-server --service-start\n)\ncd "${join(tools.getIobDir())}"\ncall iobroker host this\ncall iobroker start\nif exist "${join(bashDir, '.startAll')}" (\ncd "${join(tools.getIobDir(), 'node_modules/iobroker.js-controller')}"\nnode iobroker.js start all\n)`,
            );
        } catch (e) {
            adapter.log.error(`cannot create startIOB.bat: ${e}Please run "iobroker fix"`);
        }
    } else if (existsSync('/opt/scripts/.docker_config/.thisisdocker')) {
        // Docker Image Support >= 5.2.0
        adapter.log.debug(`BackItUp has recognized a Docker system`);

        try {
            writeFileSync(
                `${bashDir}/stopIOB.sh`,
                `#!/bin/bash\n# iobroker stop for restore\nbash ${bashDir}/external.sh`,
            );
            chmodSync(`${bashDir}/stopIOB.sh`, 508);
        } catch (e) {
            adapter.log.error(`cannot create stopIOB.sh: ${e}Please run "iobroker fix"`);
        }

        try {
            writeFileSync(
                `${bashDir}/startIOB.sh`,
                `#!/bin/bash\n# iobroker start after restore\nif [ -f ${bashDir}/.startAll ]; then\ncd "${join(tools.getIobDir())}"\niobroker start all;\nfi\nsleep 6\nbash /opt/scripts/maintenance.sh off -y`,
            );
            chmodSync(`${bashDir}/startIOB.sh`, 508);
        } catch (e) {
            adapter.log.error(`cannot create startIOB.sh: ${e}Please run "iobroker fix"`);
        }

        try {
            writeFileSync(
                `${bashDir}/external.sh`,
                `#!/bin/bash\n# restore\nbash /opt/scripts/maintenance.sh on -y -kbn\nsleep 3\nif [ -f ${bashDir}/.redis.info ]; then\ncd "${join(__dirname, 'lib')}"\nelse\ncd "${bashDir}"\nfi\nnode restore.js`,
            );
            chmodSync(`${bashDir}/external.sh`, 508);
        } catch (e) {
            adapter.log.error(`cannot create external.sh: ${e}Please run "iobroker fix"`);
        }
    } else {
        adapter.log.debug(`BackItUp has recognized a ${process.platform} system`);

        try {
            writeFileSync(
                `${bashDir}/stopIOB.sh`,
                `# iobroker stop for restore\nsudo systemd-run --uid=iobroker bash ${bashDir}/external.sh`,
            );
            chmodSync(`${bashDir}/stopIOB.sh`, 508);
        } catch (e) {
            adapter.log.error(`cannot create stopIOB.sh: ${e}Please run "iobroker fix"`);
        }

        try {
            writeFileSync(
                `${bashDir}/startIOB.sh`,
                `# iobroker start after restore\nif [ -f ${bashDir}/.redis.info ]; then\nredis-cli shutdown nosave && echo "[DEBUG] [redis] Redis restart successfully"\nfi\nif [ -f ${bashDir}/.startAll ]; then\ncd "${join(tools.getIobDir())}"\nbash iobroker start all && echo "[EXIT] **** iobroker start upload all now... ****"\nfi\ncd "${join(tools.getIobDir())}"\nbash iobroker host this && echo "[DEBUG] [iobroker] Host this successfully"\nbash iobroker start && echo "[EXIT] **** iobroker restart now... ****"`,
            );
            chmodSync(`${bashDir}/startIOB.sh`, 508);
        } catch (e) {
            adapter.log.error(`cannot create startIOB.sh: ${e}Please run "iobroker fix"`);
        }

        try {
            writeFileSync(
                `${bashDir}/external.sh`,
                `# restore\ncd "${join(tools.getIobDir())}"\nbash iobroker stop && echo "[DEBUG] [iobroker] iobroker stop successfully"\nif [ -f ${bashDir}/.redis.info ]; then\ncd "${join(__dirname, 'lib')}"\nelse\ncd "${bashDir}"\nfi\nnode restore.js`,
            );
            chmodSync(`${bashDir}/external.sh`, 508);
        } catch (e) {
            adapter.log.error(`cannot create external.sh: ${e}Please run "iobroker fix"`);
        }
    }
}

// umount after restore
function umount(): void {
    const backupDir = join(tools.getIobDir(), 'backups');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const child_process = require('node:child_process') as typeof ChildProcessModule;

    if (existsSync(`${bashDir}/.mount`)) {
        child_process.exec(`mount | grep -o "${backupDir}"`, (error, stdout) => {
            if (stdout.includes(backupDir)) {
                adapter.log.debug('mount activ... umount in 2 Seconds!!');
                timerUmount1 = setTimeout(
                    () =>
                        child_process.exec(
                            `${adapter.config.sudoMount ? 'sudo umount' : 'umount'} ${backupDir}`,
                            error => {
                                if (error) {
                                    adapter.log.debug('umount: device is busy... wait 5 Minutes!!');
                                    timerUmount2 = setTimeout(
                                        () =>
                                            child_process.exec(
                                                `${adapter.config.sudoMount ? 'sudo umount' : 'umount'} -l ${backupDir}`,
                                                error => {
                                                    if (error) {
                                                        adapter.log.error(error as unknown as string);
                                                    } else {
                                                        adapter.log.debug('umount successfully completed');
                                                        removeMountMarker();
                                                    }
                                                },
                                            ),
                                        300000,
                                    );
                                } else {
                                    adapter.log.debug('umount successfully completed');
                                    removeMountMarker();
                                }
                            },
                        ),
                    2000,
                );
            } else {
                adapter.log.debug('mount inactiv!!');
            }
        });
    }
}

/** Deletes the ".mount" marker, ignoring failures. */
function removeMountMarker(): void {
    try {
        if (existsSync(`${bashDir}/.mount`)) {
            unlinkSync(`${bashDir}/.mount`);
        }
    } catch {
        adapter.log.debug('file ".mount" not deleted ...');
    }
}

// Create Backupdir on first start
function createBackupDir(): void {
    if (!existsSync(join(tools.getIobDir(), 'backups'))) {
        try {
            mkdirSync(join(tools.getIobDir(), 'backups'));
            adapter.log.debug('Created BackupDir');
        } catch (e) {
            adapter.log.warn(
                `Backup folder not created: ${e}! Please run "iobroker fix" and try again or create the backup folder manually!!`,
            );
        }
    }
}
// delete Hide Files after restore
function deleteHideFiles(): void {
    if (existsSync(`${bashDir}/.redis.info`)) {
        unlinkSync(`${bashDir}/.redis.info`);
    }
}
// delete temp dir after restore
function delTmp(): void {
    if (existsSync(join(tools.getIobDir(), 'backups/tmp'))) {
        try {
            rmdirSync(join(tools.getIobDir(), 'backups/tmp'));
            adapter.log.debug('delete tmp files');
        } catch (e) {
            adapter.log.warn(
                `can not delete tmp files: ${e}Please run "iobroker fix" and try again or delete the tmp folder manually!!`,
            );
        }
    }
}
// set start Options after restore
function setStartAll(): void {
    if (adapter.config.startAllRestore && !existsSync(`${bashDir}/.startAll`)) {
        try {
            writeFileSync(`${bashDir}/.startAll`, 'Start all Adapter after Restore');
            adapter.log.debug('Start all Adapter after Restore enabled');
        } catch (e) {
            adapter.log.warn(`can not create startAll files: ${e}Please run "iobroker fix" and try again`);
        }
    } else if (!adapter.config.startAllRestore && existsSync(`${bashDir}/.startAll`)) {
        try {
            unlinkSync(`${bashDir}/.startAll`);
            adapter.log.debug('Start all Adapter after Restore disabled');
        } catch (e) {
            adapter.log.warn(`can not delete startAll file: ${e}Please run "iobroker fix" and try again`);
        }
    }
}

/**
 * Reads the backup timestamp out of a file name.
 *
 * @param name the backup file name
 * @param filenumbers running number, only used for the log line
 * @param storage the storage the file came from
 */
function getName(name: string, filenumbers: number, storage: string): Date | undefined {
    try {
        const parts = name.split('_');
        if (parseInt(parts[0], 10).toString() !== parts[0]) {
            parts.shift();
        }
        const storageType = storage === 'cifs' ? 'NAS' : storage;
        adapter.log.debug(
            name ? `detect backup file ${filenumbers} from ${storageType}: ${name}` : 'No backup name was found',
        );
        return new Date(
            parts[0] as unknown as number,
            parseInt(parts[1], 10) - 1,
            parseInt(parts[2].split('-')[0], 10),
            parseInt(parts[2].split('-')[1], 10),
            parseInt(parts[3], 10),
        );
    } catch (err) {
        if (err) {
            adapter.log.warn('No backup name was found');
        }
    }
}

/** A listed backup file, plus the two fields the detection below stamps onto it */
type DetectedFile = BackItUpStorageEngineResultFile & { date?: Date | string; storage?: string };

/**
 * Finds the newest iobroker backup across all enabled storages and publishes it as info.latestBackup.
 *
 * @param adapter adapter instance
 */
async function detectLatestBackupFile(adapter: ioBroker.Adapter): Promise<void> {
    // get all 'storage' types that enabled
    try {
        let stores: BackItUpStorage[] | null = (Object.keys(backupConfig.iobroker) as BackItUpStorage[]).filter(
            attr =>
                typeof backupConfig.iobroker[attr] === 'object' &&
                backupConfig.iobroker[attr].type === 'storage' &&
                backupConfig.iobroker[attr].enabled === true,
        );

        await updateAccessTokens(backupConfig);
        // read one time all stores to detect if some backups detected
        let promises: Promise<DetectedFile | null>[] | null = null;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const list = require('./lib/list') as ListBackups;
        try {
            promises = stores.map(
                storage =>
                    new Promise(resolve =>
                        list(storage, backupConfig, adapter.log, result => {
                            // find the newest file
                            let file: DetectedFile | null = null;

                            if (result && result.data && (result.data as unknown) !== 'undefined') {
                                let filenumbers = 0;
                                let data = result.data;
                                Object.keys(data).forEach(type => {
                                    const entry = data[type as keyof typeof data];
                                    if (entry?.iobroker) {
                                        entry.iobroker
                                            .filter(f => f.size)
                                            .forEach(f => {
                                                filenumbers++;
                                                const date = getName(f.name, filenumbers, storage);

                                                if (!file || (file.date as Date) < date!) {
                                                    file = f;
                                                    file.date = date;
                                                    file.storage = storage;
                                                }
                                            });
                                    }
                                });
                                result = null as never;
                                data = null as never;
                            }
                            resolve(file);
                        }),
                    ),
            );
        } catch (e) {
            adapter.log.warn(`No backup file was found: ${e}`);
        }

        // find the newest file between storages

        void Promise.all(promises!).then(all => {
            let results: DetectedFile[] | null = all.filter(f => f) as DetectedFile[];
            let file;
            if (results.length) {
                results.sort((a, b) => {
                    if (a.date! > b.date!) {
                        return 1;
                    } else if (a.date! < b.date!) {
                        return -1;
                    }
                    return 0;
                });
                file = results[0];

                if (file.date !== undefined) {
                    try {
                        file.date = (file.date as Date).toISOString();
                    } catch (e) {
                        adapter.log.warn(`No backup file date was found: ${e}`);
                    }
                }
            } else {
                file = null;
            }
            // this information will be used by admin at the first start if some backup was detected and we can restore from it instead of new configuration
            void adapter.setState('info.latestBackup', file ? JSON.stringify(file) : '', true);

            adapter.log.debug(file ? `detect last backup file: ${file.name}` : 'No backup file was found');

            results = null;
        });
        promises = null;

        stores = null;
    } catch (e) {
        adapter.log.warn(`No backup file was found: ${e}`);
    }
}

/**
 * Publishes the next scheduled run time for both backup types.
 *
 * @param setMain also refresh the type that is not `type`
 * @param type the type whose schedule just changed
 */
async function nextBackup(setMain: boolean, type: string | null): Promise<void> {
    const { CronExpressionParser } = await import('cron-parser');

    if ((adapter.config.ccuEnabled && setMain) || type === 'ccu') {
        const time = adapter.config.ccuCron ? adapter.config.ccuCronJob : adapter.config.ccuTime.split(':');
        const cron = adapter.config.ccuCron
            ? (time as string)
            : `00 ${time[1]} ${time[0]} */${adapter.config.ccuEveryXDays} * *`;

        try {
            const cronOptions = {
                currentDate: new Date(),
            };

            const interval = CronExpressionParser.parse(cron, cronOptions);
            const nextScheduledDate = interval.next();

            await adapter.setStateAsync(
                `info.ccuNextTime`,
                tools.getNextTimeString(systemLang, nextScheduledDate as unknown as Date),
                true,
            );
        } catch (e) {
            adapter.log.warn(`Your configured CCU cronjob is not correct: ${e}`);
        }
    } else if (!adapter.config.ccuEnabled) {
        await adapter.setStateAsync(`info.ccuNextTime`, 'none', true);
    }

    if ((adapter.config.minimalEnabled && setMain) || type === 'iobroker') {
        const time = adapter.config.iobrokerCron
            ? adapter.config.iobrokerCronJob
            : adapter.config.minimalTime.split(':');
        const cron = adapter.config.iobrokerCron
            ? (time as string)
            : `00 ${time[1]} ${time[0]} */${adapter.config.minimalEveryXDays} * *`;

        try {
            const cronOptions = {
                currentDate: new Date(),
            };

            const interval = CronExpressionParser.parse(cron, cronOptions);
            const nextScheduledDate = interval.next();

            await adapter.setStateAsync(
                `info.iobrokerNextTime`,
                tools.getNextTimeString(systemLang, nextScheduledDate as unknown as Date),
                true,
            );
        } catch (e) {
            adapter.log.warn(`Your configured iobroker cronjob is not correct: ${e}`);
        }
    } else if (!adapter.config.minimalEnabled) {
        await adapter.setStateAsync(`info.iobrokerNextTime`, 'none', true);
    }
}

/**
 * Triggers the backup on one slave instance and then walks on to the next.
 *
 * @param slaveInstance the instance to back up, e.g. `backitup.1`
 * @param num index into `adapter.config.slaveInstance`
 */
async function startSlaveBackup(slaveInstance: string, num: number | null): Promise<void> {
    let waitForInstance = 1000;

    if (num === null || num === undefined) {
        num = 0;
    }

    try {
        const currentState = await adapter.getForeignStateAsync(`system.adapter.${slaveInstance}.alive`);

        if (currentState && currentState.val === false) {
            waitForInstance = 10000;
            adapter.log.debug(`Try to start ${slaveInstance}`);
            await adapter.setForeignStateAsync(`system.adapter.${slaveInstance}.alive`, true);
        }
    } catch (err) {
        adapter.log.error(`error on slave State: ${err}`);
    }

    waitToSlaveBackup = setTimeout(async () => {
        try {
            const currentStateAfter = await adapter.getForeignStateAsync(`system.adapter.${slaveInstance}.alive`);

            /** Moves on to the next slave, or finishes the round. */
            const advance = (): void => {
                num!++;

                if (adapter.config.slaveInstance.length > 1 && num != adapter.config.slaveInstance.length) {
                    slaveTimeOut = setTimeout(startSlaveBackup, 3000, adapter.config.slaveInstance[num!], num);
                } else {
                    adapter.log.debug('slave backups are completed');

                    if (adapter.config.onedriveEnabled) {
                        void renewOnedriveToken();
                    }
                }
            };

            if (currentStateAfter && currentStateAfter.val && currentStateAfter.val === true) {
                const sendToSlave = await adapter.sendToAsync(slaveInstance, 'slaveBackup', {
                    config: { deleteAfter: adapter.config.minimalDeleteAfter },
                });

                if (sendToSlave) {
                    adapter.log.debug(`Slave Backup from ${slaveInstance} is finish with result: ${sendToSlave as unknown as string}`);
                } else {
                    adapter.log.debug(`Slave Backup error from ${slaveInstance}`);
                }

                if (adapter.config.stopSlaveAfter) {
                    await adapter.setForeignStateAsync(`system.adapter.${slaveInstance}.alive`, false);
                    adapter.log.debug(`${slaveInstance} is stopped after backup`);
                }

                advance();
            } else {
                adapter.log.warn(`${slaveInstance} is not running. The slave backup for this instance is not possible`);
                advance();
            }
        } catch (err) {
            adapter.log.error(`error on slave Backup: ${err}`);
        }
    }, waitForInstance);
}

/**
 * Decrypts the passwords in the multi-target event lists in place.
 *
 * @param secret the system secret
 */
function decryptEvents(secret: string): void {
    if (adapter.config.ccuEvents && adapter.config.ccuMulti) {
        for (let i = 0; i < adapter.config.ccuEvents.length; i++) {
            if (adapter.config.ccuEvents[i].pass) {
                const val = adapter.config.ccuEvents[i].pass;
                adapter.config.ccuEvents[i].pass = val ? decrypt(secret, val) : '';
            }
        }
    }
    if (adapter.config.mySqlEvents && adapter.config.mySqlMulti) {
        for (let i = 0; i < adapter.config.mySqlEvents.length; i++) {
            if (adapter.config.mySqlEvents[i].pass) {
                const val = adapter.config.mySqlEvents[i].pass;
                adapter.config.mySqlEvents[i].pass = val ? decrypt(secret, val) : '';
            }
        }
    }
    if (adapter.config.pgSqlEvents && adapter.config.pgSqlMulti) {
        for (let i = 0; i < adapter.config.pgSqlEvents.length; i++) {
            if (adapter.config.pgSqlEvents[i].pass) {
                const val = adapter.config.pgSqlEvents[i].pass;
                adapter.config.pgSqlEvents[i].pass = val ? decrypt(secret, val) : '';
            }
        }
    }
}

function clearBashDir(): void {
    // delete restore files
    if (existsSync(bashDir)) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fse = require('fs-extra') as typeof FsExtraModule;
        const restoreDir = join(bashDir, 'restore');

        try {
            if (existsSync(join(bashDir, 'restore.js'))) {
                unlinkSync(join(bashDir, 'restore.js'));
            }
            if (existsSync(join(bashDir, 'restore.json'))) {
                unlinkSync(join(bashDir, 'restore.json'));
            }
            if (existsSync(restoreDir)) {
                fse.removeSync(restoreDir);
            }

            if (existsSync(join(bashDir, 'iob.key'))) {
                unlinkSync(join(bashDir, 'iob.key'));
            }
            if (existsSync(join(bashDir, 'iob.crt'))) {
                unlinkSync(join(bashDir, 'iob.crt'));
            }
        } catch (e) {
            adapter.log.debug(`old restore files could not be deleted: ${e}`);
        }
    }
}

/**
 * Copies the admin instance's certificates into the bash directory for the restore web interface.
 *
 * @param instance the admin instance object id the request came from
 */
async function getCerts(instance: string): Promise<void> {
    const _adminCert = await adapter.getForeignObjectAsync(instance);

    if (_adminCert && _adminCert.native && _adminCert.native.certPrivate && _adminCert.native.certPublic) {
        const _cert = await adapter.getForeignObjectAsync('system.certificates');

        if (_cert && _cert.native && _cert.native.certificates) {
            try {
                const certs = _cert.native.certificates;
                const privateValue: string = certs[`${_adminCert.native.certPrivate}`];
                const publicValue: string = certs[`${_adminCert.native.certPublic}`];

                if (privateValue.startsWith('/') && existsSync(join(privateValue))) {
                    writeFileSync(join(bashDir, 'iob.key'), readFileSync(join(privateValue), 'utf8'));
                } else {
                    writeFileSync(join(bashDir, 'iob.key'), privateValue);
                }
                if (publicValue.startsWith('/') && existsSync(join(publicValue))) {
                    writeFileSync(join(bashDir, 'iob.crt'), readFileSync(join(publicValue), 'utf8'));
                } else {
                    writeFileSync(join(bashDir, 'iob.crt'), publicValue);
                }
            } catch {
                adapter.log.debug('no certificates found');
            }
        }
    }
}

/** Reads the certificate pair the two file servers use, if it was written before. */
function readServerCerts(): { key: string; cert: string } {
    let key = '';
    let cert = '';

    if (existsSync(join(bashDir, 'iob.key')) && existsSync(join(bashDir, 'iob.crt'))) {
        try {
            key = readFileSync(join(bashDir, 'iob.key'), 'utf8');
            cert = readFileSync(join(bashDir, 'iob.crt'), 'utf8');
        } catch {
            adapter.log.debug('no certificates found');
        }
    }
    return { key, cert };
}

/**
 * Starts the static file server the admin tab downloads backups from.
 *
 * @param protocol `'https:'` serves over TLS
 */
function dlFileServer(protocol: string): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const express = require('express') as (() => Express) & { static: (root: string) => RequestHandler };
    const downloadServer = express();

    // Close all connections from Downloadserver
    if (dlServer && dlServer._connectionKey) {
        try {
            dlServer.closeAllConnections();
        } catch (e) {
            adapter.log.debug(`Download server Connections could not be closed: ${e}`);
        }
        try {
            dlServer.close();
        } catch (e) {
            adapter.log.debug(`Download server Connections could not be closed: ${e}`);
        }
    }
    const port = existsSync('/opt/scripts/.docker_config/.thisisdocker') ? 9081 : 0;

    downloadServer.use(express.static(join(tools.getIobDir(), 'backups')));

    let httpServer: HttpModule.Server | undefined;
    if (protocol === 'https:') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        https = https || (require('node:https') as typeof HttpsModule);

        const { key: privateKey, cert: certificate } = readServerCerts();

        try {
            httpServer = https.createServer({ key: privateKey, cert: certificate }, downloadServer);
        } catch (e) {
            adapter.log.debug(`The https server cannot be created: ${e}`);
        }
    } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        http = http || (require('node:http') as typeof HttpModule);

        try {
            httpServer = http.createServer(downloadServer);
        } catch (e) {
            adapter.log.debug(`The http server cannot be created: ${e}`);
        }
    }

    try {
        dlServer = httpServer!.listen(port);
        adapter.log.debug(`Download ${protocol.replace(':', '')} server started on port ${serverPort(dlServer)}`);
    } catch {
        adapter.log.debug('Download server cannot be started');
    }
}

/**
 * Starts the server the admin tab uploads backups to.
 *
 * @param protocol `'https:'` serves over TLS
 */
function ulFileServer(protocol: string): void {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const express = require('express') as () => Express;
    const multer = require('multer') as MulterFactory;
    const cors = require('cors') as () => RequestHandler;
    /* eslint-enable @typescript-eslint/no-require-imports */

    // Close all Connections from upload server
    try {
        ulServer!.closeAllConnections();
    } catch {
        adapter.log.debug('Upload server connections could not be closed');
    }
    try {
        ulServer!.close();
    } catch {
        adapter.log.debug('Upload server connections could not be closed');
    }

    const port = existsSync('/opt/scripts/.docker_config/.thisisdocker') ? 9082 : 0;

    const backupDir = join(tools.getIobDir(), 'backups');

    const uploadServer = express();
    uploadServer.use(cors());

    const storage = multer.diskStorage({
        destination: (req, file, callback) => callback(null, backupDir),
        filename: function (req, file, callback) {
            adapter.log.debug(`Upload from ${file.originalname} started...`);
            callback(null, file.originalname);
        },
    });

    const upload = multer({ storage });

    uploadServer.post('/', upload.single('files'), (req, res) => {
        adapter.log.debug((req as { file?: unknown }).file as string);
        res.json({ message: 'File(s) uploaded successfully' });
    });

    let httpServer: HttpModule.Server | undefined;
    if (protocol === 'https:') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        https = https || (require('node:https') as typeof HttpsModule);

        const { key, cert } = readServerCerts();

        try {
            httpServer = https.createServer({ key, cert }, uploadServer);
        } catch (e) {
            adapter.log.debug(`The https upload server cannot be created: ${e}`);
        }
    } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        http = http || (require('node:http') as typeof HttpModule);

        try {
            httpServer = http.createServer(uploadServer);
        } catch (e) {
            adapter.log.debug(`The http upload server cannot be created: ${e}`);
        }
    }

    try {
        ulServer = httpServer!.listen(port);
        adapter.log.debug(`Upload ${protocol.replace(':', '')} server started on port ${serverPort(ulServer)}`);
    } catch {
        adapter.log.debug('Upload server cannot be started');
    }
}

async function renewOnedriveToken(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Onedrive = require('./lib/oneDriveLib') as typeof OnedriveType;
    const onedrive = new Onedrive();

    const currentDay = new Date();
    // NaN rather than the original `undefined`: both compare false against 30, and the branch that
    // subtracts it is only reachable once it has been assigned. Keeps the reads assertion-free.
    let diffDays = NaN;

    if (adapter.config.onedriveLastTokenRenew != '') {
        const lastRenew = new Date(adapter.config.onedriveLastTokenRenew);

        diffDays = parseInt(String((currentDay.getTime() - lastRenew.getTime()) / (1000 * 60 * 60 * 24))); //day difference
    }

    if (diffDays >= 30 || !adapter.config.onedriveLastTokenRenew) {
        adapter.log.debug('Renew Onedrive Refresh-Token');

        void onedrive
            .renewToken(adapter.config.onedriveAccessJson, adapter.log)
            .then(refreshToken => {
                void adapter.extendForeignObject(`system.adapter.${adapter.namespace}`, {
                    native: {
                        onedriveAccessJson: refreshToken,
                        onedriveLastTokenRenew: `${`0${currentDay.getMonth() + 1}`.slice(-2)}/${`0${currentDay.getDate()}`.slice(-2)}/${currentDay.getFullYear()}`,
                    },
                } as unknown as ioBroker.PartialInstanceObject);
            })
            .catch(err => {
                adapter.log.error(
                    err
                        ? JSON.stringify(err)
                        : 'An update of the Onedrive refresh token has failed. Please check your system!',
                );
                void adapter.registerNotification(
                    'backitup',
                    'onedriveWarn',
                    err
                        ? JSON.stringify(err)
                        : 'An update of the Onedrive refresh token has failed. Please check your system!',
                );
            });
    } else {
        adapter.log.debug(`Renew Onedrive Refresh-Token in ${30 - diffDays} days`);
    }
}

/**
 * Adapter start-up.
 *
 * @param adapter adapter instance
 */
async function main(adapter: ioBroker.Adapter): Promise<void> {
    createBashScripts();
    readLogFile();

    if (!existsSync(join(tools.getIobDir(), 'backups'))) {
        createBackupDir();
    }
    if (existsSync(`${bashDir}/.redis.info`)) {
        deleteHideFiles();
    }
    if (existsSync(join(tools.getIobDir(), 'backups/tmp'))) {
        delTmp();
    }
    clearBashDir();

    timerMain = setTimeout(function () {
        if (existsSync(`${bashDir}/.mount`)) {
            umount();
        }
        if (adapter.config.startAllRestore && !existsSync(`${bashDir}/.startAll`)) {
            setStartAll();
        }
    }, 10000);

    void adapter.getForeignObject('system.config', async (err, obj) => {
        if (obj?.common?.language) {
            systemLang = obj.common.language;
        }

        await initConfig(obj?.native?.secret || 'Zgfr56gFe87jJOM');

        void checkStates();

        if (adapter.config.hostType !== 'Slave') {
            createBackupSchedule();
            void nextBackup(true, null);

            void detectLatestBackupFile(adapter);
        }
    });

    // subscribe on all variables of this adapter instance with pattern "adapterName.X.memory*"
    adapter.subscribeStates('oneClick.*');
    adapter.subscribeStates('info.dropboxTokens');
}

// If started as allInOne/compact mode => return function to create instance.
// The original only assigned module.exports in this branch; exporting unconditionally is
// equivalent because the direct-start branch below never reads the exports.
if (!(module && module.parent)) {
    // or start the instance directly
    startAdapter();
}

export = startAdapter;
