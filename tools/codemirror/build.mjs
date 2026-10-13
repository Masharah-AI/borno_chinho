// Builds static/vendor/codemirror.min.js from entry.js (npm run build).
//
// One correction is made to @codemirror/view while bundling. Its bidi table
// classes "/" (U+002F) as a neutral, but Unicode - and so the browser - has it
// as a common number separator. With the wrong class, CodeMirror sees a
// reference such as (٢/١٧) in right-to-left text as three runs, 2 then / then
// 17, where the browser draws one number, so the arrow keys move the caret
// out of order around the slash. The rest of the table matches Unicode.
//
// The build fails if the table is not what this expects - for instance after
// an upgrade that fixes it upstream, when this correction can be removed.
import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SLASH = 0x2f;
// The table stores each class as log2 of CodeMirror's type flag.
const NEUTRAL = '8';
const NUMBER_SEPARATOR = '7';

const fixSlashBidiClass = {
    name: 'fix-slash-bidi-class',
    setup(build) {
        build.onLoad({ filter: /[\\/]@codemirror[\\/]view[\\/]dist[\\/]index\.js$/ }, async (args) => {
            const source = await readFile(args.path, 'utf8');
            const declaration = /const LowTypes = \/\*@__PURE__\*\/dec\("(\d+)"\)/.exec(source);
            if (!declaration) {
                throw new Error('@codemirror/view: bidi table LowTypes not found; check the "/" correction in build.mjs');
            }
            const table = declaration[1];
            if (table[SLASH] !== NEUTRAL) {
                throw new Error('@codemirror/view: "/" is no longer classed as neutral; the correction in build.mjs may be obsolete');
            }
            const fixed = table.slice(0, SLASH) + NUMBER_SEPARATOR + table.slice(SLASH + 1);
            return {
                contents: source.replace(declaration[0], declaration[0].replace(table, fixed)),
                loader: 'js',
            };
        });
    },
};

await esbuild.build({
    absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
    entryPoints: ['entry.js'],
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'CM',
    target: 'es2020',
    banner: {
        js: '/*! CodeMirror 6 (MIT, https://codemirror.net) - built from tools/codemirror: npm ci && npm run build */',
    },
    outfile: '../../static/vendor/codemirror.min.js',
    plugins: [fixSlashBidiClass],
});
