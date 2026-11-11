// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Builds Torflix for a Raspberry Pi's console (pi/README.md): the backend bundled into one
// file, the TV shell and its launcher, and the Node runtime that build-runtime.sh assembled,
// packed as dist/Torflix-<version>-raspberry-pi.tar.gz. `--no-pack` stops at the folder.
//
//   bash tools/pi/build-runtime.sh && node tools/pi/build.mjs

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const RUNTIME = path.join(ROOT, 'dist', 'pi-runtime');
const NAME = `Torflix-${pkg.version}-raspberry-pi`;
const OUT = path.join(ROOT, 'dist', NAME);

if (!fs.existsSync(path.join(RUNTIME, 'node'))) throw new Error(`No runtime in ${RUNTIME}: run tools/pi/build-runtime.sh first`);
await fsp.rm(OUT, { recursive: true, force: true });
await fsp.mkdir(path.join(OUT, 'app'), { recursive: true });

await build({
  entryPoints: [path.join(ROOT, 'src', 'pi', 'backend.js')],
  outfile: path.join(OUT, 'app', 'backend.mjs'),
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
  // No WebRTC peers: its addon (node-datachannel) has no build for the musl runtime's 32-bit ARM.
  alias: { 'webrtc-polyfill': path.join(ROOT, 'tools', 'android', 'webrtc-stub.js') },
  // Native addons with no 32-bit ARM build here. Each is loaded inside a try/catch, so the
  // engine runs without them, as on Android: TCP only (no uTP), no file locking, plain buffers.
  external: ['utp-native', 'fs-native-extensions', 'bufferutil', 'utf-8-validate'],
  define: { 'process.env.TORFLIX_VERSION': JSON.stringify(pkg.version) },
  legalComments: 'eof',
  logLevel: 'warning',
});

await fsp.cp(RUNTIME, path.join(OUT, 'runtime'), { recursive: true, verbatimSymlinks: true });
for (const name of await fsp.readdir(path.join(ROOT, 'pi'))) {
  await fsp.copyFile(path.join(ROOT, 'pi', name), path.join(OUT, name));
}
await fsp.copyFile(path.join(ROOT, 'assets', 'icon.png'), path.join(OUT, 'app', 'icon.png'));
await fsp.writeFile(path.join(OUT, 'app', 'VERSION'), `${pkg.version}\n`);
for (const name of ['torflix.sh', 'install.sh', 'uninstall.sh']) {
  if (fs.existsSync(path.join(OUT, name))) await fsp.chmod(path.join(OUT, name), 0o755);
}

if (!process.argv.includes('--no-pack')) {
  const archive = path.join(ROOT, 'dist', `${NAME}.tar.gz`);
  execFileSync('tar', ['-C', path.dirname(OUT), '--owner=0', '--group=0', '-czf', archive, NAME], { stdio: 'inherit' });
  console.log(`[pi] ${path.relative(ROOT, archive)} ${(fs.statSync(archive).size / 1048576).toFixed(1)} MiB`);
} else console.log(`[pi] ${path.relative(ROOT, OUT)}`);
