// Build web-picker.user.js from web-picker.src/ — esbuild IIFE bundle with
// the userscript metadata banner prepended. The built artifact is COMMITTED:
// Tampermonkey installs it straight from the raw GitHub URL, so `npm run
// build && git add web-picker.user.js` is part of every change.
//
// Zero runtime deps for the extension; esbuild is a devDependency only.

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const banner = readFileSync(join(here, 'web-picker.src/banner.js'), 'utf8');

await build({
  entryPoints: [join(here, 'web-picker.src/main.js')],
  bundle: true,
  format: 'iife',
  outfile: join(here, 'web-picker.user.js'),
  banner: { js: banner },
  charset: 'utf8',
  target: 'es2020',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
