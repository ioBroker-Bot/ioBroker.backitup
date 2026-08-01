import Onedrive from '../oneDriveLib';
import type { BackItUpConfigStorageOneDrive, BackItUpStorage } from '../types';
import type { BackItUpGetFileCallback, BackItUpListCallback } from './types';

/**
 * The engines are handed either the storage node itself or the enclosing creator node, which
 * carries the storage under its own key - hence the two-step lookup on every setting.
 */
type OneDriveOptions = Partial<BackItUpConfigStorageOneDrive> & {
    onedrive?: Partial<BackItUpConfigStorageOneDrive>;
};

export async function list(
    restoreSource: BackItUpStorage | '' | undefined,
    options: OneDriveOptions,
    types: string[],
    log: ioBroker.Logger,
    callback?: BackItUpListCallback,
): Promise<void> {
    const accessJson =
        options.onedriveAccessJson !== undefined
            ? options.onedriveAccessJson
            : options.onedrive && options.onedrive.onedriveAccessJson !== undefined
              ? options.onedrive.onedriveAccessJson
              : '';
    const configuredDir =
        options.dir !== undefined
            ? (options.dir as string)
            : options.onedrive && options.onedrive.dir !== undefined
              ? (options.onedrive.dir as string)
              : '/';
    const ownDir =
        options.ownDir !== undefined
            ? options.ownDir
            : options.onedrive && options.onedrive.ownDir !== undefined
              ? options.onedrive.ownDir
              : false;
    const dirMinimal =
        options.dirMinimal !== undefined
            ? options.dirMinimal
            : options.onedrive && options.onedrive.dirMinimal !== undefined
              ? options.onedrive.dirMinimal
              : '/';

    let od_accessToken: string | undefined;

    // Refresh token if necessary
    if (!restoreSource || restoreSource === 'onedrive') {
        const onedrive = new Onedrive();
        try {
            od_accessToken = await onedrive.getToken(accessJson, log);
        } catch (err) {
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
            } catch (error) {
                log.error(`Onedrive listBackups error: ${error}`);
                callback?.(error as Error);
            }
        } else {
            callback?.('No access token available');
        }
    } else {
        callback?.();
    }
}

export async function getFile(
    options: OneDriveOptions,
    fileName: string,
    toStoreName: string,
    log: ioBroker.Logger,
    callback?: BackItUpGetFileCallback,
): Promise<void> {
    const accessJson = options.onedriveAccessJson ?? options.onedrive?.onedriveAccessJson ?? '';
    const configuredDir = options.dir ?? options.onedrive?.dir ?? '/';
    const ownDir = options.ownDir ?? options.onedrive?.ownDir ?? false;
    const dirMinimal = options.dirMinimal ?? options.onedrive?.dirMinimal ?? '/';

    const onedrive = new Onedrive();
    const od_accessToken = await onedrive
        .getToken(accessJson, log)
        .catch(err => log.warn(`OneDrive Token: ${err}`));

    if (!od_accessToken) {
        callback?.('Not configured');
        return;
    }

    try {
        const dir = ownDir ? dirMinimal : configuredDir;
        const onlyFileName = fileName.split('/').pop() as string;

        await onedrive.downloadFileByName({
            accessToken: od_accessToken,
            dir,
            fileName: onlyFileName,
            targetPath: toStoreName,
            log,
        });

        callback?.();
    } catch (err) {
        log.error(`OneDrive: ${(err as Error).message}`);
        callback?.(err as Error);
    }
}
