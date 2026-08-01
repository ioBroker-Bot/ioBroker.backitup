"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ignoreErrors = void 0;
exports.command = command;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const tools_1 = require("../tools");
const targz_1 = require("../targz");
async function command(options, log, callback) {
    const esphomeInst = [];
    let dirs = [];
    // find all esphome dirs
    if ((0, node_fs_1.existsSync)(options.path)) {
        dirs = (0, node_fs_1.readdirSync)(options.path).filter(name => {
            const fullPath = (0, node_path_1.join)(options.path, name);
            return (0, node_fs_1.statSync)(fullPath).isDirectory() && name.startsWith('esphome.');
        });
    }
    if (dirs.length) {
        log.debug(`found esphome data: ${dirs.join(',')}`);
    }
    else {
        log.warn('no esphome data found!!');
        callback?.(null, 'done');
        return;
    }
    // Cleared after the first failure so the error is only reported once, while the loop keeps
    // going over the remaining instances.
    let cb = callback;
    for (const dirName of dirs) {
        const pth = (0, node_path_1.join)(options.path, dirName);
        const nameSuffix = options.hostType === 'Slave' ? options.slaveSuffix || '' : options.nameSuffix || '';
        const fileName = (0, node_path_1.join)(options.backupDir, `${dirName}_${(0, tools_1.getDate)()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`);
        // compress dir
        try {
            await compressAsync(pth, fileName);
            log.debug(`Backup created: ${fileName}`);
            options.context.fileNames.push(fileName);
            options.context.types.push(dirName);
            options.context.done.push(dirName);
            esphomeInst.push(dirName);
        }
        catch (err) {
            options.context.errors.esphome = err.toString();
            log.error(err);
            if (cb) {
                cb(err, err.toString());
                cb = undefined;
            }
        }
    }
    cb?.(null, 'done');
}
/**
 * compression as Promise
 *
 * @param pth directory to pack
 * @param fileName archive to write
 */
function compressAsync(pth, fileName) {
    return new Promise((resolve, reject) => {
        (0, targz_1.compress)({
            src: pth,
            dest: fileName,
            tar: {
                ignore: name => (0, node_path_1.basename)(name) === '.esphome' || (0, node_path_1.basename)(name) === '.gitignore',
            },
        }, err => {
            if (err) {
                reject(err);
            }
            else {
                resolve();
            }
        });
    });
}
exports.ignoreErrors = true;
//# sourceMappingURL=48-esphome.js.map