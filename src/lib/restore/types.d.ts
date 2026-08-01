/**
 * Reported when a restore step finishes.
 *
 * `exitCode` is either a process exit code or one of the "<x> restore done" strings that
 * lib/restore.js checks against to decide whether the run counted as a success.
 */
export type BackItUpRestoreCallback = (error?: Error | string | null, exitCode?: number | string | null) => void;

/**
 * The config slice lib/restore.js hands to a step, plus the fields it fills in itself before the
 * call. The slice differs per step, so it stays open here and each module narrows it.
 */
export interface BackItUpRestoreOptions {
    /** ioBroker backup directory; filled in by lib/restore.js when absent */
    backupDir: string;
    /** the step's own name, e.g. "mysql"; filled in by lib/restore.js when absent */
    backupType: string;
    /** used for the log prefix; filled in by lib/restore.js when absent */
    name: string;
    /** only set for the detached restore - the archive to restore from */
    fileName?: string;
    /** only set for the detached restore */
    theme?: string;
    /** only set for the detached restore */
    currentProtocol?: string;
    /** only set for the detached restore */
    bashDir?: string;
    [setting: string]: unknown;
}

/**
 * Logger the restore steps get. Unlike `ioBroker.Logger` this one has `exit` and no `info`/`warn`:
 * lib/restore.js builds it either around the adapter or, for the detached run, around a log file.
 */
export interface BackItUpRestoreLogger {
    debug: (text: unknown) => void;
    error: (text: unknown) => void;
    exit: (exitCode?: number | string | null) => void;
}

/**
 * A step that runs inside the adapter process and therefore receives the adapter instance.
 */
export interface BackItUpRestoreModule {
    restore(
        options: never,
        fileName: string,
        log: BackItUpRestoreLogger,
        adapter: ioBroker.Adapter,
        callback?: BackItUpRestoreCallback,
    ): void | Promise<void>;
    isStop: false;
}

/**
 * A step that stops ioBroker first and is therefore re-run by the detached lib/restore.js copy,
 * without an adapter instance - hence the shorter signature.
 */
export interface BackItUpRestoreStopModule {
    restore(
        options: never,
        fileName: string,
        log: BackItUpRestoreLogger,
        callback?: BackItUpRestoreCallback,
    ): void | Promise<void>;
    isStop: true;
}

export type BackItUpAnyRestoreModule = BackItUpRestoreModule | BackItUpRestoreStopModule;
