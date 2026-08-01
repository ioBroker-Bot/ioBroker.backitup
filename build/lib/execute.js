"use strict";
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const tools_1 = require("./tools");
/** The `notificationsType` value each messaging step requires */
const NOTIFIER = {
    telegram: 'Telegram',
    whatsapp: 'WhatsApp',
    gotify: 'Gotify',
    signal: 'Signal',
    matrix: 'Matrix',
    email: 'E-Mail',
    pushover: 'Pushover',
    discord: 'Discord',
};
/** Slices dropped from the debug output when they are switched off */
const DISABLED_SLICES = [
    'ftp',
    'cifs',
    'telegram',
    'pushover',
    'email',
    'whatsapp',
    'gotify',
    'discord',
    'dropbox',
    'onedrive',
    'webdav',
    'googledrive',
    'mysql',
    'sqlite',
    'pgsql',
    'influxDB',
    'grafana',
    'javascripts',
    'jarvis',
    'zigbee',
    'esphome',
    'zigbee2mqtt',
    'nodered',
    'yahka',
    'historyDB',
    'redis',
];
/** Slices whose `backupDir` is dropped from the debug output */
const BACKUP_DIR_SLICES = [
    'ftp',
    'cifs',
    'mysql',
    'sqlite',
    'pgsql',
    'influxDB',
    'grafana',
    'jarvis',
    'zigbee',
    'esphome',
    'zigbee2mqtt',
    'nodered',
    'yahka',
    'javascripts',
    'redis',
    'historyDB',
];
/** Secrets masked one level down, e.g. `_options.cifs.pass` */
const NESTED_SECRETS = {
    ftp: ['pass'],
    cifs: ['pass'],
    mysql: ['pass'],
    // Note: the dropbox slice is checked for the *onedrive* key here. Kept as found.
    dropbox: ['onedriveAccessJson'],
    onedrive: ['accessToken'],
    googledrive: ['accessJson'],
    webdav: ['pass'],
    grafana: ['apiKey', 'pass'],
    zigbee2mqtt: ['z2mPassword'],
};
/** Secrets masked directly on the options object */
const TOP_LEVEL_SECRETS = ['accessToken', 'pass', 'accessJson', 'apiKey', 'z2mPassword'];
/** Secrets masked two levels down, e.g. `_options.iobroker.cifs.pass` */
const DEEP_SECRETS = {
    dropbox: ['accessToken'],
    onedrive: ['onedriveAccessJson'],
    cifs: ['pass'],
    ftp: ['pass'],
    googledrive: ['accessJson'],
    mysql: ['pass'],
    ccu: ['pass'],
    webdav: ['pass'],
    grafana: ['pass', 'apiKey'],
    zigbee2mqtt: ['z2mPassword'],
};
let timerCleanFiles;
let tmpLog = '';
/**
 * Loads every step in lib/scripts, keyed by its name without the numeric prefix.
 *
 * Only `.js` files are picked up, so the TypeScript sources next to the compiled output are
 * ignored.
 *
 * @param callback reports a directory that cannot be read
 */
function loadScripts(callback) {
    const scripts = {};
    let files;
    try {
        files = (0, node_fs_1.readdirSync)(`${__dirname}/scripts`);
        files.forEach(file => {
            if (file.endsWith('.js')) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                scripts[file.substring(3, file.length - 3)] = require(`${__dirname}/scripts/${file}`);
            }
        });
    }
    catch (e) {
        callback(`error on backup: ${e} Please run "iobroker fix" and reinstall BackItUp`);
    }
    return scripts;
}
/**
 * Appends one line to the run log, ignoring write failures.
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
 * Prepends this run's collected output to the history log and trims it to the configured length.
 *
 * @param config the run config
 * @param adapter adapter instance, used only for the error log
 */
function createBackupLog(config, adapter) {
    // Create Backup Logs for History
    const logFile = (0, node_path_1.join)(config.notification.bashDir, `${adapter.namespace}.log`);
    if ((0, node_fs_1.existsSync)(logFile)) {
        const data = (0, node_fs_1.readFileSync)(logFile, 'utf8');
        const backupLog = JSON.parse(data);
        const timestamp = config.timestamp;
        try {
            backupLog.unshift({ [timestamp]: tmpLog });
        }
        catch (err) {
            adapter.log.error(`Backup Logs could not be created: ${err}`);
        }
        if (backupLog && backupLog.length > config.notification.entriesNumber) {
            backupLog.splice(config.notification.entriesNumber, backupLog.length - config.notification.entriesNumber);
        }
        (0, node_fs_1.writeFileSync)(logFile, JSON.stringify(backupLog));
        tmpLog = '';
    }
}
/**
 * Runs the backup steps one after another.
 *
 * Each invocation handles exactly one step and then re-schedules itself, so `scripts` and `code`
 * carry the state between the passes; the first call creates them.
 *
 * @param adapter adapter instance, or null for the detached run
 * @param config the run config
 * @param callback reports the outcome of the whole run
 * @param scripts remaining steps; a step is set to null once it has been taken
 * @param code exit code reported by the last step that supplied one
 */
function executeScripts(adapter, config, callback, scripts, code) {
    if (!scripts) {
        scripts = loadScripts(callback);
        config.backupDir = (0, node_path_1.join)((0, tools_1.getIobDir)(), 'backups').replace(/\\/g, '/');
        config.timestamp = new Date().getTime();
        config.context = { fileNames: [], errors: {}, done: [], types: [] }; // common variables between scripts
        if (!(0, node_fs_1.existsSync)(config.backupDir)) {
            try {
                (0, node_fs_1.mkdirSync)(config.backupDir);
                (0, node_fs_1.chmodSync)(config.backupDir, '0775');
            }
            catch (e) {
                callback(`Backup directory cannot created: ${e} Please reinstall BackItUp and run "iobroker fix"!!`);
            }
        }
        else if (!config.cifs.enabled || (config.cifs.enabled && config.cifs.mountType === 'Copy')) {
            try {
                (0, node_fs_1.chmodSync)(config.backupDir, '0775');
            }
            catch (e) {
                callback(`chmod for Backup directory could not be completed: ${e} Please run "iobroker fix"!!`);
            }
        }
    }
    for (const name in scripts) {
        if (Object.prototype.hasOwnProperty.call(scripts, name) &&
            scripts[name] &&
            (!config.afterBackup || scripts[name].afterBackup)) {
            let func;
            // Open on purpose: the slice differs per step and main.js is still JS.
            let options;
            switch (name) {
                // Mount tasks
                case 'mount':
                    if (config.cifs && config.cifs.enabled && config.cifs.mount) {
                        func = scripts[name];
                        options = config.cifs;
                    }
                    break;
                case 'umount':
                    if (config.cifs && config.cifs.enabled && config.cifs.mount) {
                        func = scripts[name];
                        options = config.cifs;
                    }
                    break;
                // Copy/delete tasks
                case 'clean':
                    func = scripts[name];
                    options = {
                        name: config.name,
                        deleteBackupAfter: config.deleteBackupAfter,
                        ignoreErrors: config.ignoreErrors,
                    };
                    break;
                case 'cifs':
                case 'webdav':
                case 'dropbox':
                case 'onedrive':
                case 'googledrive':
                case 'ftp':
                    if (config[name] && config[name].enabled) {
                        func = scripts[name];
                        options = Object.assign({}, config[name], {
                            name: config.name,
                            deleteBackupAfter: config.deleteBackupAfter,
                        });
                    }
                    break;
                // Extra data sources
                case 'mysql':
                case 'sqlite':
                case 'pgsql':
                case 'redis':
                case 'historyDB':
                case 'javascripts':
                case 'zigbee':
                case 'esphome':
                case 'zigbee2mqtt':
                case 'nodered':
                case 'yahka':
                case 'grafana':
                case 'jarvis':
                case 'influxDB':
                    // The original spelled these out one by one with identical bodies.
                    if (config.name === 'iobroker' && config[name] && config[name].enabled) {
                        func = scripts[name];
                        options = Object.assign({}, config[name]);
                    }
                    break;
                // Main tasks
                case 'ccu':
                case 'iobroker':
                    if (config.name === name && config.enabled && config.slaveBackup !== 'Slave') {
                        func = scripts[name];
                        options = config;
                    }
                    break;
                // Messaging tasks
                case 'historyHTML':
                case 'historyJSON':
                    if (config[name] && config[name].enabled) {
                        func = scripts[name];
                        try {
                            options = JSON.parse(JSON.stringify(config));
                            options[name].time = (0, tools_1.getTimeString)(options[name].systemLang); // provide date
                        }
                        catch {
                            callback(`cannot parse config for ${name}!!`);
                        }
                    }
                    break;
                case 'telegram':
                case 'whatsapp':
                case 'gotify':
                case 'signal':
                case 'matrix':
                case 'email':
                case 'pushover':
                case 'discord':
                    // Each channel only runs when it is the selected notification type.
                    if (config[name] && config[name].enabled && config[name].notificationsType === NOTIFIER[name]) {
                        func = scripts[name];
                        try {
                            options = JSON.parse(JSON.stringify(config));
                            options[name].time = (0, tools_1.getTimeString)(options[name].systemLang); // provide date
                        }
                        catch {
                            callback(`cannot parse config for ${name}!!`);
                        }
                    }
                    break;
                case 'notification':
                    if (config[name]) {
                        func = scripts[name];
                        try {
                            options = JSON.parse(JSON.stringify(config));
                            options[name].time = (0, tools_1.getTimeString)(options[name].systemLang); // provide date
                        }
                        catch {
                            callback('cannot parse config for notification!!');
                        }
                    }
                    break;
            }
            scripts[name] = null;
            if (func) {
                try {
                    // A masked copy, only ever used for the debug line below.
                    const _options = JSON.parse(JSON.stringify(options));
                    for (const key of DISABLED_SLICES) {
                        if (_options[key] && !_options[key].enabled) {
                            delete _options[key];
                        }
                    }
                    for (const key of BACKUP_DIR_SLICES) {
                        if (_options[key] && _options[key].backupDir !== undefined) {
                            delete _options[key].backupDir;
                        }
                    }
                    if (!_options.nameSuffix && _options.nameSuffix !== undefined) {
                        delete _options.nameSuffix;
                    }
                    if (_options.enabled !== undefined) {
                        delete _options.enabled;
                    }
                    if (_options.context !== undefined) {
                        delete _options.context;
                    }
                    if (_options.name !== undefined) {
                        delete _options.name;
                    }
                    for (const [slice, secrets] of Object.entries(NESTED_SECRETS)) {
                        if (_options[slice]) {
                            for (const secret of secrets) {
                                if (_options[slice][secret] !== undefined) {
                                    _options[slice][secret] = '****';
                                }
                            }
                        }
                    }
                    for (const secret of TOP_LEVEL_SECRETS) {
                        if (_options[secret] !== undefined) {
                            _options[secret] = '****';
                        }
                    }
                    if (_options.adapter !== undefined) {
                        delete _options.adapter;
                    }
                    // One more level down: the notification steps get the whole config, so the
                    // storage credentials sit under `_options.<backupType>.<storage>`.
                    for (const i in _options) {
                        if (_options[i] !== null) {
                            for (const [slice, secrets] of Object.entries(DEEP_SECRETS)) {
                                if (_options[i][slice] !== undefined && _options[i][slice]) {
                                    for (const secret of secrets) {
                                        _options[i][slice][secret] = '****';
                                    }
                                }
                            }
                        }
                    }
                    if (_options.debugging == true) {
                        setTimeout(function () {
                            void adapter?.setState('output.line', `[DEBUG] [${name}] start with ${JSON.stringify(_options)}`, true);
                        }, 200);
                    }
                }
                catch (e) {
                    callback(`error on backup process: Script "${name}" ${e} Please check the config of BackItUp and execute "iobroker fix"`);
                    timerCleanFiles = setTimeout(function () {
                        setImmediate(executeScripts, adapter, config, callback, scripts, code);
                    }, 150);
                    return;
                }
                if (!options) {
                    callback(`error on backup process: No valid options for "${name}" Please check the config of BackItUp and execute "iobroker fix"`);
                    timerCleanFiles = setTimeout(function () {
                        setImmediate(executeScripts, adapter, config, callback, scripts, code);
                    }, 150);
                    return;
                }
                options.context = config.context;
                options.backupDir = config.backupDir;
                options.timestamp = config.timestamp;
                options.adapter = adapter;
                // for delete on Multi-Backup
                if (config.influxDB && config.influxDB.influxDBMulti) {
                    options.influxDBMulti = config.influxDB.influxDBMulti;
                }
                if (config.influxDB && config.influxDB.influxDBEvents) {
                    options.influxDBEvents = config.influxDB.influxDBEvents;
                }
                if (config.mysql && config.mysql.mySqlMulti) {
                    options.mySqlMulti = config.mysql.mySqlMulti;
                }
                if (config.mysql && config.mysql.mySqlEvents) {
                    options.mySqlEvents = config.mysql.mySqlEvents;
                }
                if (config.pgsql && config.pgsql.pgSqlMulti) {
                    options.pgSqlMulti = config.pgsql.pgSqlMulti;
                }
                if (config.pgsql && config.pgsql.pgSqlEvents) {
                    options.pgSqlEvents = config.pgsql.pgSqlEvents;
                }
                if (config.ccuMulti) {
                    options.ccuMulti = config.ccuMulti;
                }
                if (config.ccuEvents) {
                    options.ccuEvents = config.ccuEvents;
                }
                const fileName = (0, node_path_1.join)(config.backupDir, 'logs.txt');
                const log = {
                    debug: function (input) {
                        // Steps also pass Errors and Buffers here; this is the coercion the
                        // original did in place.
                        const text = typeof input === 'string' ? input : input.toString();
                        const lines = text.toString().split('\n');
                        lines.forEach(line => {
                            line = line.replace(/\r/g, ' ').trim();
                            if (line && adapter) {
                                adapter.log.debug(`[${config.name}/${name}] ${line}`);
                            }
                            if (line && !adapter) {
                                writeIntoFile(fileName, `[DEBUG] [${config.name}/${name}] ${line}`);
                            }
                            void adapter?.setState('output.line', `[DEBUG] [${name}] - ${text}`, true);
                        });
                        tmpLog += `[DEBUG] [${name}] ${text}${text.endsWith('\n') ? '' : '\n'}`;
                        void adapter?.setState('output.line', `[DEBUG] [${name}] - ${text}`, true);
                    },
                    warn: function (warning) {
                        const lines = (warning || '').toString().split('\n');
                        lines.forEach(line => {
                            line = line.replace(/\r/g, ' ').trim();
                            if (line && adapter) {
                                adapter.log.warn(`[${config.name}/${name}] ${line}`);
                            }
                            if (line && !adapter) {
                                writeIntoFile(fileName, `[WARN] [${config.name}/${name}] ${line}`);
                            }
                        });
                        // Unlike debug this does not coerce first, so a non-string warning throws.
                        tmpLog += `[WARN] [${name}] ${warning}${warning.endsWith('\n') ? '' : '\n'}`;
                        void adapter?.setState('output.line', `[WARN] [${name}] - ${warning}`, true);
                    },
                    error: function (err) {
                        const lines = (err || '').toString().split('\n');
                        lines.forEach(line => {
                            line = line.replace(/\r/g, ' ').trim();
                            if (line && adapter) {
                                adapter.log.error(`[${config.name}/${name}] ${line}`);
                            }
                            if (line && !adapter) {
                                writeIntoFile(fileName, `[ERROR] [${config.name}/${name}] ${line}`);
                            }
                        });
                        tmpLog += `[ERROR] [${name}] ${err}\n`;
                        void adapter?.setState('output.line', `[ERROR] [${name}] - ${err}`, true);
                    },
                };
                try {
                    // generic Error handling for all synchron errors in backup scripts
                    // `BackItUpScript.command` declares `options: never` so each step can narrow it
                    // to its own slice; the dispatcher is the one place that has to widen it again.
                    const command = func.command;
                    command(options, log, (err, output, _code) => {
                        options.adapter = null;
                        if (_code !== undefined) {
                            code = _code;
                        }
                        if (err) {
                            // The step's own `ignoreErrors` is not consulted - the config value is.
                            if (options.ignoreErrors) {
                                log.error(`[IGNORED] ${err}`);
                                timerCleanFiles = setTimeout(function () {
                                    setImmediate(executeScripts, adapter, config, callback, scripts, code);
                                }, 150);
                            }
                            else {
                                log.error(err);
                                callback?.(err);
                            }
                        }
                        else {
                            log.debug((output || 'done'));
                            timerCleanFiles = setTimeout(function () {
                                setImmediate(executeScripts, adapter, config, callback, scripts, code);
                            }, 150);
                        }
                    });
                }
                catch (e) {
                    callback(`error on backup process: Error when executing script "${name}": ${e} Please check the config of BackItUp and execute "iobroker fix"`);
                    timerCleanFiles = setTimeout(function () {
                        setImmediate(executeScripts, adapter, config, callback, scripts, code);
                    }, 150);
                }
            }
            else {
                timerCleanFiles = setTimeout(function () {
                    setImmediate(executeScripts, adapter, config, callback, scripts, code);
                }, 150);
            }
            return;
        }
    }
    void adapter?.setState('output.line', `[EXIT] ${code || 0}`, true);
    createBackupLog(config, adapter);
    clearTimeout(timerCleanFiles);
    callback?.();
}
module.exports = executeScripts;
//# sourceMappingURL=execute.js.map