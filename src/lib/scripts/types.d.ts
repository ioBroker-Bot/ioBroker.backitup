import type { BackItUpExecuteContext } from '../types';

/**
 * Reported when a backup step finishes. Most steps call it with a single error or with nothing.
 */
export type BackItUpScriptCallback = (
    error?: Error | string | null,
    /**
     * Command output. Several steps put the caught Error in this slot instead; lib/execute only
     * feeds it to `log.debug`, so both occur in practice.
     */
    stdout?: string | Error | null,
    /**
     * Process exit code. Only 10-iobroker fills this; lib/execute carries it to the end of the run
     * and writes it to the `output.line` state as `[EXIT] <code>`.
     */
    code?: number | null,
) => void;

/**
 * Every step gets the config slice lib/execute picked for it, plus the shared `context`. The slice
 * differs per step, so it stays open here and each script narrows it to what it actually reads.
 */
export type BackItUpScriptOptions = {
    context: BackItUpExecuteContext;
    [setting: string]: unknown;
};

/** Contract every module under lib/scripts/ exports */
export interface BackItUpScript {
    command(options: never, log: ioBroker.Logger, callback: BackItUpScriptCallback): void | Promise<void>;
    /** when true a failure of this step does not fail the whole backup */
    ignoreErrors: boolean;
    /** when true the step also runs in the "after backup" pass */
    afterBackup?: boolean;
}
