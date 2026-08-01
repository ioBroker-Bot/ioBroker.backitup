import { existsSync, readdir } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copy, ensureDir, remove } from 'fs-extra';

import { getDate } from '../tools';
import { compress } from '../targz';
import type { BackItUpExecuteContext } from '../types';
import type { BackItUpScriptCallback } from './types';

interface JarvisOptions {
    context: BackItUpExecuteContext;
    adapter: ioBroker.Adapter;
    /** directory containing the `jarvis` folder */
    path: string;
    backupDir: string;
    hostType?: 'Single' | 'Master' | 'Slave';
    slaveSuffix?: string;
    nameSuffix?: string;
}

interface JarvisState {
    id: string;
    value: ioBroker.StateValue;
}

export async function command(
    options: JarvisOptions,
    log: ioBroker.Logger,
    callback?: BackItUpScriptCallback,
): Promise<void> {
    const jarvisDir = join(options.path, 'jarvis');
    let num = 0;

    let cb = callback;

    if (existsSync(jarvisDir)) {
        try {
            readdir(jarvisDir, (_err, files) => {
                if (files) {
                    // Note: the per-instance work is started for every entry at once without
                    // awaiting, so the instances are packed concurrently. Kept as found.
                    files.forEach(async file => {
                        const tmpDir = join(options.backupDir, `tmpJavis${file}`).replace(/\\/g, '/');

                        if (!existsSync(tmpDir)) {
                            try {
                                await ensureDir(tmpDir);
                                log.debug(`Created jarvis_tmp directory: "${tmpDir}"`);
                            } catch (err) {
                                log.warn(`Jarvis tmp directory "${tmpDir}" cannot created ... ${err}`);
                            }
                        } else {
                            try {
                                log.debug(`Try deleting the old jarvis_tmp directory: "${tmpDir}"`);
                                await remove(tmpDir);
                            } catch (err) {
                                log.warn(`Jarvis tmp directory "${tmpDir}" cannot deleted ... ${err}`);
                            }
                            if (!existsSync(tmpDir)) {
                                try {
                                    log.debug(`old jarvis_tmp directory "${tmpDir}" successfully deleted`);
                                    await ensureDir(tmpDir);
                                    log.debug('Created jarvis_tmp directory');
                                } catch (err) {
                                    log.warn(`Jarvis tmp directory "${tmpDir}" cannot created ... ${err}`);
                                }
                            }
                        }
                        log.debug(`found Jarvis Instance: ${file}`);
                        log.debug(`start Jarvis Backup for Instance ${file}...`);

                        let nameSuffix;
                        if (options.hostType === 'Slave') {
                            nameSuffix = options.slaveSuffix ? options.slaveSuffix : '';
                        } else {
                            nameSuffix = options.nameSuffix ? options.nameSuffix : '';
                        }

                        const fileName = join(
                            options.backupDir,
                            `jarvis.${file}_${getDate()}${nameSuffix ? `_${nameSuffix}` : ''}_backupiobroker.tar.gz`,
                        );
                        const instanceDir = join(jarvisDir, file);

                        try {
                            await copy(instanceDir, tmpDir);
                            log.debug(`${instanceDir} copy success!`);
                        } catch (err) {
                            log.error(`${instanceDir} copy error: ${err}`);
                        }

                        await saveState(options, file, tmpDir, log);

                        options.context.fileNames.push(fileName);

                        compress(
                            {
                                src: tmpDir,
                                dest: fileName,
                            },
                            // lib/targz only ever passes an error; the stdout/stderr parameters the
                            // original declared here were always undefined.
                            async err => {
                                try {
                                    log.debug(`Try deleting the Jarvis tmp directory: "${tmpDir}"`);
                                    await remove(tmpDir);
                                    if (!existsSync(tmpDir)) {
                                        log.debug(`Jarvis tmp directory "${tmpDir}" successfully deleted`);
                                    }
                                } catch (e) {
                                    log.warn(`Jarvis tmp directory "${tmpDir}" cannot deleted ... ${e}`);
                                }
                                num++;
                                if (err) {
                                    options.context.errors.jarvis = err.toString();
                                    if (cb) {
                                        cb(err);
                                        cb = undefined;
                                    }
                                } else {
                                    log.debug(`Backup created: ${fileName}`);
                                    options.context.done.push(`jarvis.${file}`);
                                    options.context.types.push(`jarvis.${file}`);
                                    if (cb && num === files.length) {
                                        cb(null);
                                        cb = undefined;
                                    }
                                }
                            },
                        );
                    });
                } else {
                    log.warn(`Jarvis Backup cannot created. Please install a Jarvis version >= 2.2.0`);
                    cb?.(null, 'done');
                    cb = undefined;
                }
            });
        } catch (e) {
            log.warn(`Jarvis Backup cannot created: ${e}`);
            cb?.(null, e as Error);
            cb = undefined;
        }
    } else {
        log.warn(`Jarvis Backup cannot created. Please install a Jarvis version >= 2.2.0`);
        cb?.(null, 'done');
        cb = undefined;
    }
}

/**
 * Collects the jarvis settings and states into `states.json` next to the copied instance data.
 *
 * @param options script options
 * @param file instance folder name
 * @param tmpDir prepared copy of the instance
 * @param log adapter logger
 */
async function saveState(
    options: JarvisOptions,
    file: string,
    tmpDir: string,
    log: ioBroker.Logger,
): Promise<void> {
    const stateDir = join(tmpDir, 'states').replace(/\\/g, '/');

    if (!existsSync(stateDir)) {
        try {
            await ensureDir(stateDir);
            log.debug(`Created states_tmp directory: "${stateDir}"`);
        } catch (err) {
            log.warn(`states tmp directory "${stateDir}" cannot created ... ${err}`);
        }
    }

    const _settings = await options.adapter.getForeignObjectsAsync(`jarvis.${file}.settings.*`, 'state');

    const jarvisStates: JarvisState[] = [];

    if (_settings) {
        for (const i in _settings) {
            try {
                const obj = await options.adapter.getForeignStateAsync(`${_settings[i]._id}`);

                if (obj) {
                    jarvisStates.push({
                        id: _settings[i]._id,
                        value: obj.val ? obj.val : null,
                    });
                } else {
                    log.warn(`settings "${_settings[i]._id}" not found`);
                }
            } catch (err) {
                log.warn(`No State found for "${_settings[i]._id}": ${err}`);
            }
        }
    } else {
        log.warn('settings not found');
    }

    const _states = ['css', 'devices', 'layout', 'notifications', 'widgets', 'scripts', 'theme'];

    // for-of over the literal array; the original used for-in, which yields the same order here.
    for (const stateName of _states) {
        try {
            const obj = await options.adapter.getForeignStateAsync(`jarvis.${file}.${stateName}`);

            if (obj) {
                jarvisStates.push({
                    id: `jarvis.${file}.${stateName}`,
                    value: obj.val ? obj.val : null,
                });
            } else {
                log.warn(`settings "${stateName}" not found`);
            }
        } catch (err) {
            log.warn(`No State found for "jarvis.${file}.${stateName}": ${err}`);
        }
    }

    try {
        const _pro = await options.adapter.getForeignStateAsync(`jarvis.${file}.info.pro`);

        if (_pro) {
            jarvisStates.push({
                id: `jarvis.${file}.info.pro`,
                value: _pro.val ? _pro.val : null,
            });
        } else {
            log.warn('settings "pro" not found');
        }
    } catch (err) {
        log.debug(`No State found for "jarvis.${file}.info.pro": ${err}`);
    }

    await writeFile(join(stateDir, `states.json`), JSON.stringify(jarvisStates, null, 2)).catch(err =>
        log.warn(`states.json cannot be written: ${err}`),
    );
}

export const ignoreErrors = true;
