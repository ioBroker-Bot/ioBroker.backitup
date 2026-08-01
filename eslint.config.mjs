// ioBroker eslint template configuration file for js and ts files
// Please note that esm or react based modules need additional modules loaded.
import config from '@iobroker/eslint-config';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * While the backend is being migrated to TypeScript, lib/ holds both hand-written .js and the
 * compiler output of the already converted modules. A generated file is recognisable by having a
 * sibling .ts of the same name - linting those only reports on code nobody edits, so they are
 * collected here and ignored. Once the migration is done this resolves to all of lib/.
 */
function generatedJs(roots = ['lib', '.'], out = []) {
    for (const root of roots) {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            const p = join(root, entry.name);
            if (entry.isDirectory()) {
                if (root !== '.') {
                    generatedJs([p], out);
                }
            } else if (entry.name.endsWith('.js') && existsSync(`${p.slice(0, -3)}.ts`)) {
                out.push(p.replace(/\\/g, '/'));
            }
        }
    }
    return out;
}

export default [
    ...config,

    {
        // specify files to exclude from linting here
        ignores: [
            'src-admin/**/*',
            'src-tab/**/*',
            'admin/**/*',
            'node_modules/**/*',
            'test/**/*',
            'build/**/*',
            'tasks.js',
            'tmp/**/*',
            '.**/*',
            '.dev-server/',
            '.vscode/',
            '*.test.js',
            'test/**/*.js',
            '*.config.mjs',
            'build',
            'admin/build',
            'admin/words.js',
            'admin/admin.d.ts',
            '**/adapter-config.d.ts',
            // compiler output of the already converted backend modules
            ...generatedJs(),
        ]
    },

    {
        // Backend modules being migrated to TypeScript.
        files: ['lib/**/*.ts', 'main.ts'],
        rules: {
            // The promise chains here reject with the plain strings and API error objects that the
            // callers have always matched on ('Not found', 'Not configured', Dropbox error bodies).
            // Wrapping them in Error would change what every consumer receives, so the rule is off
            // for the ported code rather than worked around case by case.
            '@typescript-eslint/prefer-promise-reject-errors': 'off',
            // Several engine entry points are declared `async` without awaiting anything. That is
            // part of their existing shape - dropping the keyword would turn the returned promise
            // into undefined for any caller that awaits them.
            '@typescript-eslint/require-await': 'off',
        },
    },

    {
        // you may disable some 'jsdoc' warnings - but using jsdoc is highly recommended
        // as this improves maintainability. jsdoc warnings will not block buiuld process.
        rules: {
            'jsdoc/require-jsdoc': 'off',
            'no-async-promise-executor': 'off',
            'prettier/prettier': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-prototype-builtins': 'off',
            'curly': 'off',
            'jsdoc/require-returns-description': 'off',
            'no-else-return': 'off',
            'no-case-declarations': 'off',
            'no-useless-escape': 'off',
            //'jsdoc/require-param': 'off',
            //'@typescript-eslint/ban-ts-comment': 'off',
            //'@typescript-eslint/no-require-imports': 'off',
            //'jsdoc/no-types': 'off',
            //'jsdoc/tag-lines': 'off',
        },
    },
];
