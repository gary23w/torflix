// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Prepares what the Android app ships: the backend bundled into one file, and the renderer,
// shared code, icons and bridge shim it serves. By default the output goes where the APK picks
// it up (android/app/src/main/assets/torflix/); `--out <dir>` writes it elsewhere, e.g. to try
// the backend on this machine.
//
//   node tools/android/build.mjs [--out <dir>]

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argOut = process.argv.indexOf('--out');
const OUT = argOut > 0 ? path.resolve(process.argv[argOut + 1]) : path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'torflix');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

await fsp.rm(OUT, { recursive: true, force: true });
await fsp.mkdir(OUT, { recursive: true });

await build({
  entryPoints: [path.join(ROOT, 'src', 'android', 'backend.js')],
  outfile: path.join(OUT, 'backend.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // CommonJS dependencies inside an ES module bundle still call require() and read __dirname.
  banner: {
    js: [
      "import { createRequire as __tfCreateRequire } from 'node:module';",
      "import { fileURLToPath as __tfFileURLToPath } from 'node:url';",
      "import { dirname as __tfDirname } from 'node:path';",
      'const require = __tfCreateRequire(import.meta.url);',
      'const __filename = __tfFileURLToPath(import.meta.url);',
      'const __dirname = __tfDirname(__filename);',
    ].join('\n'),
  },
  alias: { 'webrtc-polyfill': path.join(ROOT, 'tools', 'android', 'webrtc-stub.js') },
  // Native addons without an Android build. Each is loaded inside a try/catch, so the engine
  // runs without them: TCP only (no uTP), no file locking, plain WebSocket buffers.
  external: ['utp-native', 'fs-native-extensions', 'bufferutil', 'utf-8-validate'],
  define: { 'process.env.TORFLIX_VERSION': JSON.stringify(pkg.version) },
  legalComments: 'eof',
  logLevel: 'warning',
});

await fsp.cp(path.join(ROOT, 'src', 'renderer'), path.join(OUT, 'renderer'), { recursive: true });
await fsp.cp(path.join(ROOT, 'src', 'shared'), path.join(OUT, 'shared'), { recursive: true });
// Icons only: the demo recording stays out of the APK.
await fsp.mkdir(path.join(OUT, 'assets'), { recursive: true });
for (const entry of await fsp.readdir(path.join(ROOT, 'assets'), { withFileTypes: true })) {
  if (entry.isFile()) await fsp.copyFile(path.join(ROOT, 'assets', entry.name), path.join(OUT, 'assets', entry.name));
}
await fsp.mkdir(path.join(OUT, 'android'), { recursive: true });
const shim = path.join(ROOT, 'src', 'android', 'tp-shim.js');
if (fs.existsSync(shim)) await fsp.copyFile(shim, path.join(OUT, 'android', 'tp-shim.js'));
else console.warn('[android] src/android/tp-shim.js is missing: the page will have no window.tp.');

const size = (await fsp.stat(path.join(OUT, 'backend.mjs'))).size;
console.log(`[android] ${path.relative(ROOT, OUT) || OUT}: backend.mjs ${(size / 1048576).toFixed(1)} MiB, renderer, shared, assets, android`);
