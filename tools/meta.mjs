// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The Torflix metadata service (meta/): copies the title-information code it runs from
// src/shared into meta/lib, then
//
//   node tools/meta.mjs            copies only
//   node tools/meta.mjs --serve    serves it on http://127.0.0.1:8787 to try it (no CDN)
//   node tools/meta.mjs --deploy   deploys it to Vercel (project torflix-meta), in production
//
// The app and the service run the same code, so a title is found the same way by both.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meta = path.join(root, 'meta');
const lib = path.join(meta, 'lib');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

fs.rmSync(lib, { recursive: true, force: true });
fs.mkdirSync(path.join(lib, 'shared', 'meta'), { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'src', 'shared', 'meta'))) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(root, 'src', 'shared', 'meta', f), path.join(lib, 'shared', 'meta', f));
}
// The one module outside the folder they use (titleKey).
fs.copyFileSync(path.join(root, 'src', 'shared', 'release.js'), path.join(lib, 'shared', 'release.js'));
fs.writeFileSync(path.join(lib, 'version.js'), `// Written by tools/meta.mjs.\nexport const VERSION = ${JSON.stringify(version)};\n`);
console.log(`[meta] meta/lib: title-information code of Torflix ${version}`);

if (process.argv.includes('--serve')) {
  const { handle } = await import(pathToFileURL(path.join(lib, 'shared', 'meta', 'service.js')));
  const { httpGet } = await import(pathToFileURL(path.join(lib, 'shared', 'meta', 'http.js')));
  const { userAgent } = await import(pathToFileURL(path.join(lib, 'shared', 'meta', 'util.js')));
  const get = httpGet(userAgent(version, 'metadata service, local'));
  http
    .createServer(async (req, res) => {
      const started = Date.now();
      const out = await handle(new URL(req.url, 'http://x').pathname, get).catch((err) => ({ status: 500, cacheControl: 'no-store', body: { error: err.message } }));
      res.writeHead(out.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': out.cacheControl });
      res.end(JSON.stringify(out.body));
      console.log(`[meta] ${out.status} ${req.url} ${Date.now() - started} ms`);
    })
    .listen(8787, '127.0.0.1', () => console.log('[meta] http://127.0.0.1:8787/v1/health'));
} else if (process.argv.includes('--deploy')) {
  // On Windows the CLI is a .cmd script, which only cmd.exe runs.
  const run = (args) => {
    const r = process.platform === 'win32' ? spawnSync('cmd.exe', ['/d', '/c', 'vercel', ...args], { cwd: meta, stdio: 'inherit' }) : spawnSync('vercel', args, { cwd: meta, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };
  if (!fs.existsSync(path.join(meta, '.vercel', 'project.json'))) run(['link', '--yes', '--project', 'torflix-meta']);
  run(['deploy', '--prod', '--yes']);
}
