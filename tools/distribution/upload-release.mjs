// SPDX-License-Identifier: MIT OR Apache-2.0
// Add artifacts without ever replacing an existing application binary.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const repo = 'gary23w/torflix';
const tag = `v${pkg.version}`;
const directory = path.resolve(process.argv[2] || path.join(root, 'dist/release'));
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const getRelease = () => JSON.parse(gh('api', `repos/${repo}/releases/tags/${tag}`));
const initial = getRelease();

for (const name of (await fs.readdir(directory)).sort()) {
  if (!/\.(?:zip|dmg|deb|rpm|AppImage)$/.test(name)) continue;
  const file = path.join(directory, name);
  if (!(await fs.stat(file)).isFile()) continue;
  const sha = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const existing = initial.assets.find(asset => asset.name === name);
  if (existing) {
    if (existing.digest !== `sha256:${sha}`) throw new Error(`Refusing to replace existing release asset: ${name}`);
    console.log(`Already published, hash matches: ${name}`);
    continue;
  }
  gh('release', 'upload', tag, file, '--repo', repo);
  console.log(`Published ${name} sha256:${sha}`);
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
