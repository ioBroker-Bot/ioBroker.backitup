"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFile = getFile;
exports.restore = restore;
/**
 * Restore dispatcher.
 *
 * IMPORTANT: for an ioBroker restore this file is copied to the bash directory together with
 * `restore/iobroker.js` and started there as a detached process (see `restore()` below). Nothing
 * else from lib/ travels with it, so every `require` of a sibling module - and of express/cors,
 * which are only needed by the detached web interface - has to stay inside a function. Hoisting
 * any of them to the top would break the standalone run with "Cannot find module".
 *
 * Only `node:fs` and `node:path` are imported eagerly; both are builtins and always resolvable.
 */
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/** Exit codes the detached run counts as a success, alongside a numeric 0 */
const DONE_MARKERS = [
    'mysql restore done',
    'sqlite restore done',
    'redis restore done',
    'historyDB restore done',
    'zigbee database restore done',
    'ESPHome data restore done',
    'node-red restore done',
    'yahka database restore done',
    'jarvis database restore done',
    'influxDB restore done',
    'postgresql restore done',
    'Grafana restore done',
    'javascript restore done',
];
let logWebIF = '';
let statusColor = '';
let restoreStatus = '';
let startFinish = '';
let httpServer;
/**
 * Appends one line to the detached run's log file, ignoring write failures.
 *
 * @param fileName log file to append to
 * @param text the line; empty values are skipped
 */
function writeIntoFile(fileName, text) {
    if (text) {
        console.log(text);
        try {
            (0, node_fs_1.appendFileSync)(fileName, `${text}\n`);
        }
        catch {
            // ignore
        }
    }
}
/**
 * Digs the config slice for one backup type out of the options.
 *
 * Looks at the top level first, then one level down for the backup type and finally one level down
 * for the storage type.
 *
 * @param options the whole restore config
 * @param backupType e.g. `'mysql'`
 * @param storageType e.g. `'cifs'`; when given and the top-level hit matched, its sub-slice is used
 */
function getConfig(options, backupType, storageType) {
    let config = options[backupType];
    if (!config) {
        for (const attr in options) {
            if (Object.prototype.hasOwnProperty.call(options, attr) &&
                typeof options[attr] === 'object' &&
                options[attr][backupType]) {
                config = options[attr][backupType];
                break;
            }
        }
        if (!config) {
            for (const attr in options) {
                if (Object.prototype.hasOwnProperty.call(options, attr) &&
                    typeof options[attr] === 'object' &&
                    options[attr][storageType]) {
                    config = options[attr][storageType];
                    break;
                }
            }
        }
    }
    else if (storageType) {
        return config[storageType];
    }
    return config;
}
/**
 * Fetches the archive from the selected storage into the local backup directory.
 *
 * @param options the whole restore config
 * @param storageType where the file comes from; `'local'` copies instead of downloading
 * @param fileName the file as the storage names it
 * @param toSaveName the local target path
 * @param log restore logger
 * @param callback reports the download result
 */
function getFile(options, storageType, fileName, toSaveName, log, callback) {
    if ((0, node_fs_1.existsSync)(toSaveName)) {
        callback(null, toSaveName);
    }
    else {
        const name = fileName.split('/').pop();
        let backupType = name.split('.')[0];
        if (backupType !== 'nodered' &&
            backupType !== 'zigbee' &&
            backupType !== 'jarvis' &&
            backupType !== 'yahka' &&
            backupType !== 'esphome') {
            backupType = name.split('_')[0];
        }
        if (name.match(/^\d\d\d\d_\d\d_\d\d-\d\d_\d\d_\d\d_backupiobroker\.tar\.gz$/)) {
            backupType = 'iobroker';
        }
        const config = getConfig(options, backupType, storageType);
        if (storageType !== 'local') {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const _getFile = require(`./list/${storageType}`).getFile;
            _getFile(config, fileName, toSaveName, log, callback);
        }
        else {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const tools = require('./tools');
            tools.copyFile(fileName, toSaveName, callback);
        }
    }
}
/**
 * Launches the stop script that in turn re-runs this file as a detached process.
 *
 * @param bashDir directory holding stopIOB.sh / stopIOB.bat
 */
function startDetachedRestore(bashDir) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('node:child_process');
    const isWin = process.platform.startsWith('win');
    const spawnOptions = {
        detached: true,
        cwd: __dirname,
        stdio: ['ignore', 'ignore', 'ignore'],
    };
    if (isWin) {
        spawnOptions.shell = true;
    }
    const cmd = spawn(isWin ? `${bashDir}/stopIOB.bat` : 'bash', [isWin ? '' : `${bashDir}/stopIOB.sh`], spawnOptions);
    cmd.unref();
}
/**
 * Starts ioBroker again after a detached restore and then shuts this process down.
 *
 * @param bashDir directory holding startIOB.sh / startIOB.bat
 */
function startIOB(bashDir) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const child_process = require('node:child_process');
    const isWin = process.platform.startsWith('win');
    startFinish = '[Restart]';
    let timeFinish = 10000;
    if ((0, node_fs_1.existsSync)('/opt/scripts/.docker_config/.thisisdocker')) {
        timeFinish = 3000;
        logWebIF += '[EXIT] **** Docker Container restart now... ****\n';
    }
    setTimeout(() => (startFinish = '[Finish]'), timeFinish);
    child_process.exec(isWin ? `${bashDir}/startIOB.bat` : `bash ${bashDir}/startIOB.sh`, (error, stdout, stderr) => {
        if (error) {
            logWebIF += `[ERROR] ${error}\n`;
            logWebIF += `[ERROR] ${stderr}\n`;
        }
        else if (stdout) {
            logWebIF += `${stdout}\n`;
        }
        setTimeout(() => {
            try {
                httpServer?.close();
                httpServer = null;
            }
            catch (e) {
                console.error(e);
            }
            process.exit();
        }, 30 * 1000);
    });
}
/**
 * Restores one backup.
 *
 * Steps that stop ioBroker first (`isStop`) are not run here: their config is written to
 * restore.json and a detached copy of this file picks it up.
 *
 * @param adapter adapter instance, or null when this is the detached run
 * @param options the whole restore config
 * @param storageType where the archive comes from
 * @param fileName the archive as the storage names it
 * @param currentTheme admin theme, handed to the detached web interface
 * @param currentProtocol admin protocol, handed to the detached web interface
 * @param bashDir directory holding the start/stop scripts
 * @param log restore logger, used for the detached run
 * @param callback reports the result
 */
function restore(adapter, options, storageType, fileName, currentTheme, currentProtocol, bashDir, log, callback) {
    options = JSON.parse(JSON.stringify(options));
    if (storageType === 'nas / copy') {
        storageType = 'cifs';
    }
    if (adapter) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const tools = require('./tools');
        const backupDir = (0, node_path_1.join)(tools.getIobDir(), 'backups').replace(/\\/g, '/');
        if (storageType === 'local') {
            try {
                (0, node_fs_1.chmodSync)(backupDir, '0775');
                log.debug(`set chmod for "${backupDir}" successfully`);
            }
            catch (err) {
                log.debug(`cannot set chmod for "${backupDir}": ${err}`);
            }
        }
        const name = fileName.split('/').pop();
        const toSaveName = (0, node_path_1.join)(backupDir, name);
        getFile(options, storageType, fileName, toSaveName, log, err => {
            if (!err && (0, node_fs_1.existsSync)(toSaveName)) {
                let backupType = name.split('.')[0];
                if (backupType !== 'nodered' &&
                    backupType !== 'zigbee' &&
                    backupType !== 'jarvis' &&
                    backupType !== 'yahka' &&
                    backupType !== 'esphome') {
                    backupType = name.split('_')[0];
                }
                // Shadows the outer `log` for the whole block: inside the adapter process everything
                // goes to the adapter log and the output.line state instead of a file.
                //
                // NOTE: the original declared this further down, after the redis branch below
                // already called `log.debug`. Because `const` shadows for the entire block that
                // call hit the temporal dead zone, so restoring a redis backup from the admin UI
                // always threw "ReferenceError: Cannot access 'log' before initialization".
                // Moving the declaration up is the smallest repair; a TypeScript build refuses to
                // emit the original form at all.
                const log = {
                    debug: text => {
                        const lines = text.toString().split('\n');
                        lines.forEach(line => {
                            line = line.replace(/\r/g, ' ').trim();
                            if (line) {
                                adapter.log.debug(`[${backupType}] ${line}`);
                            }
                        });
                        void adapter?.setState('output.line', `[DEBUG] [${backupType}] - ${text}`, true);
                    },
                    error: textError => {
                        const lines = textError.toString().split('\n');
                        lines.forEach(line => {
                            line = line.replace(/\r/g, ' ').trim();
                            if (line) {
                                adapter.log.error(`[${backupType}] ${line}`);
                            }
                        });
                        void adapter?.setState('output.line', `[ERROR] [${backupType}] - ${textError}`, true);
                    },
                    exit: exitCode => {
                        void adapter?.setState('output.line', `[EXIT] ${exitCode || 0}`, true);
                    },
                };
                if (backupType === 'redis') {
                    (0, node_fs_1.writeFileSync)(`${bashDir}/.redis.info`, 'Stop redis-server before Restore');
                    log.debug('Redis-Server stopped');
                }
                if (name.match(/^\d\d\d\d_\d\d_\d\d-\d\d_\d\d_\d\d_backupiobroker\.tar\.gz$/)) {
                    backupType = 'iobroker';
                }
                const config = getConfig(options, backupType);
                config.backupDir = config.backupDir || backupDir;
                config.backupType = config.backupType || backupType;
                config.name = config.name || backupType;
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const _module = require(`./restore/${backupType}`);
                if (_module.isStop) {
                    if (backupType === 'iobroker' && (0, node_fs_1.existsSync)(bashDir)) {
                        // copy restore files
                        const restoreDir = (0, node_path_1.join)(bashDir, 'restore');
                        const restoreSource = (0, node_path_1.join)(__dirname, 'restore');
                        tools.copyFile((0, node_path_1.join)(__dirname, 'restore.js'), (0, node_path_1.join)(bashDir, 'restore.js'));
                        if (!(0, node_fs_1.existsSync)(restoreDir)) {
                            (0, node_fs_1.mkdirSync)(restoreDir);
                        }
                        tools.copyFile((0, node_path_1.join)(restoreSource, `${backupType}.js`), (0, node_path_1.join)(restoreDir, `${backupType}.js`));
                    }
                    config.fileName = toSaveName;
                    config.theme = currentTheme;
                    config.currentProtocol = currentProtocol;
                    config.bashDir = bashDir;
                    (0, node_fs_1.writeFileSync)(`${backupType === 'iobroker' ? bashDir : __dirname}/restore.json`, JSON.stringify(config, null, 2));
                    startDetachedRestore(bashDir);
                    callback?.({ error: '' });
                    return;
                }
                const restoreStep = _module.restore;
                restoreStep(config, toSaveName, log, adapter, (err, exitCode) => {
                    log.exit(exitCode);
                    callback({ error: err, exitCode });
                });
            }
            else {
                callback({ error: err || `File ${toSaveName} not found` });
            }
        });
    }
    else {
        try {
            const config = options;
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const _module = require(`./restore/${config.backupType}`);
            const restoreStep = _module.restore;
            restoreStep(config, config.fileName, log, (err, exitCode) => {
                log.exit(exitCode);
                callback({ error: err, exitCode });
            });
        }
        catch (e) {
            log.error(e);
            log.exit(-1);
        }
    }
}
/**
 * Serves the progress page the admin tab polls while ioBroker is down.
 *
 * @param currentTheme admin theme, decides the dark flag
 * @param currentProtocol `'https:'` serves over TLS when certificates are present
 * @param bashDir directory the certificates are read from
 */
// WebInterface Restore
function restoreIF(currentTheme, currentProtocol, bashDir) {
    // Both are CJS `export =` factories; only the call signature is needed here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const express = require('express');
    const app = express();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cors = require('cors');
    app.use(cors());
    app.get('/status.json', (req, res) => {
        res.setHeader('content-type', 'application/json');
        res.json({
            logWebIF: logWebIF || 'Restore is started ...',
            startFinish,
            statusColor,
            restoreStatus,
            dark: currentTheme === 'dark' || currentTheme === 'react-blue' || currentTheme === 'react-dark',
        });
    });
    if (currentProtocol === 'https:') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const https = require('node:https');
        let privateKey = '';
        let certificate = '';
        if ((0, node_fs_1.existsSync)((0, node_path_1.join)(bashDir, 'iob.key')) && (0, node_fs_1.existsSync)((0, node_path_1.join)(bashDir, 'iob.crt'))) {
            try {
                privateKey = (0, node_fs_1.readFileSync)((0, node_path_1.join)(bashDir, 'iob.key'), 'utf8');
                certificate = (0, node_fs_1.readFileSync)((0, node_path_1.join)(bashDir, 'iob.crt'), 'utf8');
            }
            catch {
                console.log('no certificates found');
            }
        }
        const credentials = { key: privateKey, cert: certificate };
        httpServer = https.createServer(credentials, app);
    }
    else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const http = require('node:http');
        httpServer = http.createServer(app);
    }
    httpServer.listen(8091);
}
// The original only assigned module.exports in the `module.parent` branch. Exporting
// unconditionally is equivalent: in the detached run below nothing reads the exports.
if (!(typeof module !== 'undefined' && module.parent)) {
    if ((0, node_fs_1.existsSync)(`${__dirname}/restore.json`)) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const config = require(`${__dirname}/restore.json`);
        const logName = (0, node_path_1.join)(config.backupDir, 'logs.txt').replace(/\\/g, '/');
        startFinish = '[Restore]';
        restoreStatus = 'The ioBroker is currently being restored';
        restoreIF(config.theme, config.currentProtocol, config.bashDir);
        const log = {
            debug: text => {
                const lines = text.toString().split('\n');
                lines.forEach(line => {
                    line = line.replace(/\r/g, ' ').trim();
                    if (line) {
                        writeIntoFile(logName, `[DEBUG] [${config.name}] ${line}`);
                        logWebIF += `[DEBUG] [${config.name}] ${line}\n`;
                    }
                });
            },
            error: err => {
                const lines = err.toString().split('\n');
                lines.forEach(line => {
                    line = line.replace(/\r/g, ' ').trim();
                    if (line) {
                        writeIntoFile(logName, `[ERROR] [${config.name}] ${line}`);
                        logWebIF += `[ERROR] [${config.name}] ${line}\n`;
                    }
                });
            },
            exit: exitCode => {
                writeIntoFile(logName, `[EXIT] ${exitCode}`);
                if (exitCode == 0 || DONE_MARKERS.includes(exitCode)) {
                    logWebIF += `[EXIT] ${exitCode} **** Restore completed successfully!! ****\n`;
                    statusColor = '#00b204';
                    restoreStatus = 'Restore completed successfully!! Starting iobroker... Please wait!';
                }
                else {
                    logWebIF += `[EXIT] ${exitCode} **** Restore was canceled!! ****\n`;
                    statusColor = '#c62828';
                    restoreStatus =
                        'Restore was canceled!! If ioBroker does not start automatically, please start it manually';
                }
            },
        };
        restore(null, config, null, null, null, null, null, log, () => startIOB(config.bashDir));
    }
    else {
        console.log(`No config found at "${(0, node_path_1.normalize)((0, node_path_1.join)(__dirname, 'restore.json'))}"`);
    }
}
//# sourceMappingURL=restore.js.map