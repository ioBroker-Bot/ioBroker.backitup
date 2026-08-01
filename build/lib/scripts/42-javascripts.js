"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const fs_extra_1 = require("fs-extra");
const tools_1 = require("../tools");
const targz_1 = require("../targz");
let timerLog;
async function sleep(ms) {
    return new Promise(resolve => {
        timerLog = setTimeout(() => resolve(), ms);
    });
}
/**
 * Mode for the temporary script directory.
 *
 * Note: this is a string, and fs-extra's `getMode` spreads a non-number into its defaults, so the
 * value is discarded and the directory ends up with the default 0o777. Passing `{ mode: 0o2775 }`
 * - the form 36-grafana uses - would actually apply it. Left as found; changing directory
 * permissions is not something to slip into a type migration.
 */
const desiredMode = '0o2775';
async function command(options, log, callback) {
    let nameSuffix;
    if (options.hostType === 'Slave') {
        nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
    }
    else {
        nameSuffix = options.nameSuffix ? options.nameSuffix : '';
    }
    const fileName = (0, node_path_1.join)(options.backupDir, `javascripts_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`);
    options.context.fileNames.push(fileName);
    let cb = callback;
    const timer = setInterval(() => {
        if ((0, node_fs_1.existsSync)(fileName)) {
            const stats = (0, node_fs_1.statSync)(fileName);
            const fileSize = Math.floor(stats.size / (1024 * 1024));
            log.debug(`Packed ${fileSize}MB so far...`);
        }
    }, 5000);
    const tmpDir = (0, node_path_1.join)(options.backupDir, 'tmpScripts').replace(/\\/g, '/');
    // The cast only silences the type; the value handed over is unchanged (see desiredMode).
    const modeArg = desiredMode;
    if (!(0, node_fs_1.existsSync)(tmpDir)) {
        try {
            (0, fs_extra_1.ensureDirSync)(tmpDir, modeArg);
            log.debug(`Created javascript_tmp directory: "${tmpDir}"`);
        }
        catch (err) {
            log.warn(`Javascript tmp directory "${tmpDir}" cannot created ... ${err}`);
        }
    }
    else {
        try {
            log.debug(`Try deleting the old javascript_tmp directory: "${tmpDir}"`);
            (0, fs_extra_1.removeSync)(tmpDir);
        }
        catch (err) {
            log.warn(`Javascript tmp directory "${tmpDir}" cannot deleted ... ${err}`);
        }
        if (!(0, node_fs_1.existsSync)(tmpDir)) {
            try {
                log.debug(`old javascript_tmp directory "${tmpDir}" successfully deleted`);
                (0, fs_extra_1.ensureDirSync)(tmpDir, modeArg);
                log.debug('Created javascript_tmp directory');
            }
            catch (err) {
                log.warn(`Javascript tmp directory "${tmpDir}" cannot created ... ${err}`);
            }
        }
    }
    const obj = await options.adapter.getForeignObjectsAsync('script.*', 'script');
    if (obj) {
        try {
            await (0, promises_1.writeFile)((0, node_path_1.join)(tmpDir, 'script.json'), JSON.stringify(obj, null, 2));
        }
        catch (e) {
            log.error(`script.json cannot be written: ${e}`);
        }
        for (const i in obj) {
            log.debug(`found Script: ${obj[i]._id.split('.').pop()}`);
            await sleep(150);
        }
    }
    else {
        log.warn('Scripts not found');
    }
    if ((0, node_fs_1.existsSync)(tmpDir) && obj) {
        (0, targz_1.compress)({
            src: tmpDir,
            dest: fileName,
            tar: {
                // ignore .tar.gz and tar.sbk files when packing
                ignore: name => (0, node_path_1.extname)(name) === '.gz' || (0, node_path_1.extname)(name) === '.sbk',
            },
        }, 
        // lib/targz only ever passes an error; the stdout/stderr parameters the original
        // declared here were always undefined.
        err => {
            clearInterval(timer);
            try {
                log.debug(`Try deleting the Javascript tmp directory: "${tmpDir}"`);
                (0, fs_extra_1.removeSync)(tmpDir);
                if (!(0, node_fs_1.existsSync)(tmpDir)) {
                    log.debug(`Javascript tmp directory "${tmpDir}" successfully deleted`);
                }
            }
            catch (e) {
                log.warn(`Javascript tmp directory "${tmpDir}" cannot deleted ... ${e}`);
            }
            if (err) {
                options.context.errors.javascripts = err.toString();
                clearTimeout(timerLog);
                if (cb) {
                    cb(err);
                    cb = undefined;
                }
            }
            else {
                log.debug(`Backup created: ${fileName}`);
                options.context.done.push('javascripts');
                options.context.types.push('javascripts');
                clearTimeout(timerLog);
                if (cb) {
                    cb(null);
                    cb = undefined;
                }
            }
        });
    }
    else {
        log.warn('javascript Backup not created');
        clearTimeout(timerLog);
        // Note: the interval started above is not cleared on this path - kept as found.
        cb?.(null);
        cb = undefined;
    }
}
exports.ignoreErrors = true;
//# sourceMappingURL=42-javascripts.js.map