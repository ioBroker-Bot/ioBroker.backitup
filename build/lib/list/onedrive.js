"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.list = list;
exports.getFile = getFile;
const oneDriveLib_1 = __importDefault(require("../oneDriveLib"));
async function list(restoreSource, options, types, log, callback) {
    const accessJson = options.onedriveAccessJson !== undefined
        ? options.onedriveAccessJson
        : options.onedrive && options.onedrive.onedriveAccessJson !== undefined
            ? options.onedrive.onedriveAccessJson
            : '';
    const configuredDir = options.dir !== undefined
        ? options.dir
        : options.onedrive && options.onedrive.dir !== undefined
            ? options.onedrive.dir
            : '/';
    const ownDir = options.ownDir !== undefined
        ? options.ownDir
        : options.onedrive && options.onedrive.ownDir !== undefined
            ? options.onedrive.ownDir
            : false;
    const dirMinimal = options.dirMinimal !== undefined
        ? options.dirMinimal
        : options.onedrive && options.onedrive.dirMinimal !== undefined
            ? options.onedrive.dirMinimal
            : '/';
    let od_accessToken;
    // Refresh token if necessary
    if (!restoreSource || restoreSource === 'onedrive') {
        const onedrive = new oneDriveLib_1.default();
        try {
            od_accessToken = await onedrive.getToken(accessJson, log);
        }
        catch (err) {
            log.warn(`Onedrive Token: ${err}`);
        }
        if (od_accessToken) {
            let dir = (configuredDir || '').replace(/\\/g, '/');
            // Use minimal path if ownDir is true
            if (ownDir === true) {
                dir = (dirMinimal || '').replace(/\\/g, '/');
            }
            // Normalize directory format
            if (!dir || dir[0] !== '/') {
                dir = `/${dir || ''}`;
            }
            // Unreachable - the step above always leaves at least '/'. Kept as found.
            if (!dir) {
                dir = 'root';
            }
            if (dir.startsWith('/')) {
                dir = dir.substring(1);
            }
            try {
                // Call internal listBackups method from class
                const files = await onedrive.listBackups({ accessToken: od_accessToken, dir, types, log });
                callback?.(null, files, 'onedrive');
            }
            catch (error) {
                log.error(`Onedrive listBackups error: ${error}`);
                callback?.(error);
            }
        }
        else {
            callback?.('No access token available');
        }
    }
    else {
        callback?.();
    }
}
async function getFile(options, fileName, toStoreName, log, callback) {
    const accessJson = options.onedriveAccessJson ?? options.onedrive?.onedriveAccessJson ?? '';
    const configuredDir = options.dir ?? options.onedrive?.dir ?? '/';
    const ownDir = options.ownDir ?? options.onedrive?.ownDir ?? false;
    const dirMinimal = options.dirMinimal ?? options.onedrive?.dirMinimal ?? '/';
    const onedrive = new oneDriveLib_1.default();
    const od_accessToken = await onedrive
        .getToken(accessJson, log)
        .catch(err => log.warn(`OneDrive Token: ${err}`));
    if (!od_accessToken) {
        callback?.('Not configured');
        return;
    }
    try {
        const dir = ownDir ? dirMinimal : configuredDir;
        const onlyFileName = fileName.split('/').pop();
        await onedrive.downloadFileByName({
            accessToken: od_accessToken,
            dir,
            fileName: onlyFileName,
            targetPath: toStoreName,
            log,
        });
        callback?.();
    }
    catch (err) {
        log.error(`OneDrive: ${err.message}`);
        callback?.(err);
    }
}
//# sourceMappingURL=onedrive.js.map