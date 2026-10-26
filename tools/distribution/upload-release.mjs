// SPDX-License-Identifier: MIT OR Apache-2.0
// Add artifacts to the version's release. A published binary is kept, never replaced, unless
// its name matches TORFLIX_REPLACE (a regular expression), for swapping out a broken build.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const repo = 'gary23w/torflix';
const tag = `v${pkg.version}`;
const directory = path.resolve(process.argv[2] || path.join(root, 'dist/release'));
const replace = process.env.TORFLIX_REPLACE ? new RegExp(process.env.TORFLIX_REPLACE) : null;
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const getRelease = () => JSON.parse(gh('api', `repos/${repo}/releases/tags/${tag}`));
const initial = getRelease();

for (const name of (await fs.readdir(directory)).sort()) {
  if (!/\.(?:exe|zip|dmg|deb|rpm|AppImage)$/.test(name)) continue;
  const file = path.join(directory, name);
  if (!(await fs.stat(file)).isFile()) continue;
  const sha = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const existing = initial.assets.find(asset => asset.name === name);
  if (existing?.digest === `sha256:${sha}`) {
    console.log(`Already published, hash matches: ${name}`);
    continue;
  }
  if (existing && !replace?.test(name)) {
    // Builds are not byte-for-byte reproducible, so a rebuild differs from what was published.
    console.log(`Kept the published ${name} (this build differs; TORFLIX_REPLACE replaces it)`);
    continue;
  }
  gh('release', 'upload', tag, file, '--repo', repo, ...(existing ? ['--clobber'] : []));
  console.log(`${existing ? 'Replaced' : 'Published'} ${name} sha256:${sha}`);
}

const release = getRelease();
const sums = release.assets.filter(asset => /\.(?:exe|apk|zip|dmg|deb|rpm|AppImage)$/.test(asset.name))
  .map(asset => {
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error(`Missing GitHub SHA-256 for ${asset.name}`);
    return `${asset.digest.slice(7)}  ${asset.name}`;
  }).sort().join('\n') + '\n';
const sumFile = path.join(directory, 'SHA256SUMS');
await fs.writeFile(sumFile, sums);
gh('release', 'upload', tag, sumFile, '--repo', repo, '--clobber');
console.log(`Updated SHA256SUMS for ${tag}`);
