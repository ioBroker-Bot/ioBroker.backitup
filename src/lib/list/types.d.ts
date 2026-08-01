import type { BackItUpStorage, BackItUpConfigStorage } from '../types';

export type BackItUpStorageEngineResultFile = {
    path: string;
    name: string;
    /**
     * Byte size. Most engines report a number straight from `fs.stat`, but the Google Drive API
     * returns it as a string and that value is passed through untouched, so both actually occur on
     * the wire. The UI only ever compares and interpolates it, which works for either.
     */
    size: number | string;
    /** set by the cloud engines that address files by id rather than by path */
    id?: string | null;
};

/**
 * Backups of one storage, grouped by backup type.
 *
 * The key is derived from the file name at runtime (`grafana_2026_01_…` -> `grafana`), so it is
 * modelled as an open index rather than a closed union. In practice it holds the members of
 * `BackItUpWhatToSave`.
 */
export interface BackItUpStorageEngineResult {
    [backupType: string]: BackItUpStorageEngineResultFile[] | undefined;
}

/**
 * Key a storage engine files its result under.
 *
 * Usually the storage name, but the CIFS engine reports `'nas / copy'` - the value the restore tab
 * and lib/restore.ts both expect for a NAS source.
 */
export type BackItUpStorageKey = BackItUpStorage | 'nas / copy';

export type BackItUpStorageFiles = Partial<Record<BackItUpStorageKey, BackItUpStorageEngineResult>>;

/** What lib/list.ts hands back: every storage that answered, plus the last error seen */
export interface BackItUpListResult {
    error: Error | string | null | undefined;
    data: BackItUpStorageFiles;
}

/**
 * @param error message, if the listing failed
 * @param result the files found, grouped by backup type
 * @param storage which storage produced the result - the caller files it under this key
 */
export type BackItUpListCallback = (
    error?: Error | string | null,
    result?: BackItUpStorageEngineResult | null,
    storage?: BackItUpStorageKey,
) => void;

export type BackItUpGetFileCallback = (error?: Error | string | null) => void;

/** Contract every module under lib/list/ implements */
export interface BackItUpStorageEngine {
    list(
        restoreSource: BackItUpStorage | '' | undefined,
        options: BackItUpConfigStorage,
        types: string[],
        log: ioBroker.Logger,
        callback: BackItUpListCallback,
    ): void;

    getFile(
        options: BackItUpConfigStorage,
        fileName: string,
        toStoreName: string,
        log: ioBroker.Logger,
        callback: BackItUpGetFileCallback,
    ): void;
}
