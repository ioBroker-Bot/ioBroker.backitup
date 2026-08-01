"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.list = list;
exports.getFile = getFile;
const googleDriveLib_1 = __importDefault(require("../googleDriveLib"));
function settings(options) {
    return {
        accessJson: options.accessJson !== undefined
            ? options.accessJson
            : options.googledrive && options.googledrive.accessJson !== undefined
                ? options.googledrive.accessJson
                : '',
        dir: options.dir !== undefined
            ? options.dir
            : options.googledrive && options.googledrive.dir !== undefined
                ? options.googledrive.dir
                : '/',
        ownDir: options.ownDir !== undefined
            ? options.ownDir
            : options.googledrive && options.googledrive.ownDir !== undefined
                ? options.googledrive.ownDir
                : false,
        dirMinimal: options.dirMinimal !== undefined
            ? options.dirMinimal
            : options.googledrive && options.googledrive.dirMinimal !== undefined
                ? options.googledrive.dirMinimal
                : '/',
        newToken: options.newToken !== undefined
            ? options.newToken
            : options.googledrive && options.googledrive.newToken !== undefined
                ? options.googledrive.newToken
                : '',
    };
}
/**
 * Applies the "own directory" switch and makes sure the path is absolute
 *
 * @param dir configured target directory
 * @param ownDir whether the minimal backup uses its own directory
 * @param dirMinimal directory used when `ownDir` is set
 */
function targetDir(dir, ownDir, dirMinimal) {
    let result = (dir || '').replace(/\\/g, '/');
    if (ownDir === true) {
        result = (dirMinimal || '').replace(/\\/g, '/');
    }
    if (!result || result[0] !== '/') {
        result = `/${result || ''}`;
    }
    return result;
}
function list(restoreSource, options, types, _log, callback) {
    const { accessJson, dir: gdDir, ownDir, dirMinimal, newToken } = settings(options);
    if (accessJson && (!restoreSource || restoreSource === 'googledrive')) {
        let gDrive;
        try {
            gDrive = new googleDriveLib_1.default(accessJson, newToken);
            if (!gDrive) {
                callback?.('No or invalid access key');
                return;
            }
        }
        catch {
            callback?.('No or invalid access key');
            return;
        }
        const dir = targetDir(gdDir, ownDir, dirMinimal);
        gDrive
            .getFileOrFolderId(dir)
            .then(id => {
            if (!id) {
                // Reported an empty array here before; an empty object is what every other
                // engine returns and what the result type describes. Both are read with
                // `Object.keys()` / property access downstream, so this reads the same.
                callback?.(null, {}, 'googledrive');
                return undefined;
            }
            return gDrive.listFilesInFolder(id).then(entries => {
                const result = entries
                    .map((file) => ({
                    path: file.name,
                    name: file.name,
                    size: file.size,
                    id,
                }))
                    .filter(file => (types.includes(file.name.split('_')[0]) ||
                    types.includes(file.name.split('.')[0])) &&
                    file.name.split('.').pop() === 'gz');
                const files = {};
                result.forEach(file => {
                    const type = file.name.split('_')[0];
                    files[type] = files[type] || [];
                    files[type].push(file);
                });
                callback?.(null, files, 'googledrive');
            });
        })
            .catch(err => callback?.(err));
    }
    else {
        setImmediate(() => callback?.());
    }
}
function getFile(options, fileName, toStoreName, log, callback) {
    const { accessJson, dir: gdDir, ownDir, dirMinimal, newToken } = settings(options);
    if (accessJson) {
        const gDrive = new googleDriveLib_1.default(accessJson, newToken);
        if (!gDrive) {
            callback?.('No or invalid access key');
            return;
        }
        const dir = targetDir(gdDir, ownDir, dirMinimal);
        log.debug(`Download of "${fileName}" started`);
        gDrive
            .getFileOrFolderId(dir)
            .then(folderId => {
            if (!folderId) {
                callback?.('Folder not found');
                return undefined;
            }
            return gDrive.getFileOrFolderId(fileName, folderId);
        })
            .then(fileId => {
            if (!fileId) {
                callback?.('File not found');
                return undefined;
            }
            return gDrive.readFile(fileId, toStoreName);
        })
            .then(() => {
            log.debug(`Download of "${fileName}" done`);
            callback?.();
        })
            .catch(err => {
            if (err) {
                log.error(err);
            }
            callback?.(err);
        });
    }
    else {
        setImmediate(() => callback?.('Not configured'));
    }
}
//# sourceMappingURL=googledrive.js.map