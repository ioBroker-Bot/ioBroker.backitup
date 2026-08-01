import GoogleDrive from '../googleDriveLib';
import type { BackItUpConfigStorageGoogleDrive, BackItUpStorage } from '../types';
import type {
    BackItUpGetFileCallback,
    BackItUpListCallback,
    BackItUpStorageEngineResult,
    BackItUpStorageEngineResultFile,
} from './types';

/**
 * The engines are handed either the storage node itself or the enclosing creator node, which
 * carries the storage under its own key - hence the two-step lookup on every setting.
 */
type GoogleDriveOptions = Partial<BackItUpConfigStorageGoogleDrive> & {
    googledrive?: Partial<BackItUpConfigStorageGoogleDrive>;
};

function settings(options: GoogleDriveOptions): {
    accessJson: string;
    dir: string;
    ownDir: boolean;
    dirMinimal: string;
    newToken: boolean | string;
} {
    return {
        accessJson:
            options.accessJson !== undefined
                ? options.accessJson
                : options.googledrive && options.googledrive.accessJson !== undefined
                  ? options.googledrive.accessJson
                  : '',
        dir:
            options.dir !== undefined
                ? (options.dir as string)
                : options.googledrive && options.googledrive.dir !== undefined
                  ? (options.googledrive.dir as string)
                  : '/',
        ownDir:
            options.ownDir !== undefined
                ? options.ownDir
                : options.googledrive && options.googledrive.ownDir !== undefined
                  ? options.googledrive.ownDir
                  : false,
        dirMinimal:
            options.dirMinimal !== undefined
                ? options.dirMinimal
                : options.googledrive && options.googledrive.dirMinimal !== undefined
                  ? options.googledrive.dirMinimal
                  : '/',
        newToken:
            options.newToken !== undefined
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
function targetDir(dir: string, ownDir: boolean, dirMinimal: string): string {
    let result = (dir || '').replace(/\\/g, '/');

    if (ownDir === true) {
        result = (dirMinimal || '').replace(/\\/g, '/');
    }

    if (!result || result[0] !== '/') {
        result = `/${result || ''}`;
    }

    return result;
}

export function list(
    restoreSource: BackItUpStorage | '' | undefined,
    options: GoogleDriveOptions,
    types: string[],
    _log: ioBroker.Logger,
    callback?: BackItUpListCallback,
): void {
    const { accessJson, dir: gdDir, ownDir, dirMinimal, newToken } = settings(options);

    if (accessJson && (!restoreSource || restoreSource === 'googledrive')) {
        let gDrive: GoogleDrive;
        try {
            gDrive = new GoogleDrive(accessJson, newToken);

            if (!gDrive) {
                callback?.('No or invalid access key');
                return;
            }
        } catch {
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
                        .map(
                            (file): BackItUpStorageEngineResultFile => ({
                                path: file.name as string,
                                name: file.name as string,
                                size: file.size as string,
                                id,
                            }),
                        )
                        .filter(
                            file =>
                                (types.includes(file.name.split('_')[0]) ||
                                    types.includes(file.name.split('.')[0])) &&
                                file.name.split('.').pop() === 'gz',
                        );

                    const files: BackItUpStorageEngineResult = {};
                    result.forEach(file => {
                        const type = file.name.split('_')[0];
                        files[type] = files[type] || [];
                        files[type].push(file);
                    });
                    callback?.(null, files, 'googledrive');
                });
            })
            .catch(err => callback?.(err));
    } else {
        setImmediate(() => callback?.());
    }
}

export function getFile(
    options: GoogleDriveOptions,
    fileName: string,
    toStoreName: string,
    log: ioBroker.Logger,
    callback?: BackItUpGetFileCallback,
): void {
    const { accessJson, dir: gdDir, ownDir, dirMinimal, newToken } = settings(options);

    if (accessJson) {
        const gDrive = new GoogleDrive(accessJson, newToken);

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
    } else {
        setImmediate(() => callback?.('Not configured'));
    }
}
