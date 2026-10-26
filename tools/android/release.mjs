// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Builds the Android release APKs, named the way the app's updater looks for them
// (dist/android/torflix-<version>-<abi>.apk), and with --publish puts them up as the GitHub
// release v<version>. Every Torflix on a TV takes that release the next time it starts
// (android/app/src/main/java/io/torflix/app/Updater.kt). The version is package.json's: raise it
// first, since a TV only takes a newer version than its own.
//
//   node tools/android/release.mjs [--publish] [--notes <text>]
//
// Needs JDK 17 (JAVA_HOME), and for --publish the GitHub CLI (gh), signed in to an account that
// can write to the repository, which needs at least one commit for the release's tag.

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The repository the app's update feed reads (UPDATE_FEED in android/app/build.gradle.kts).
const REPO = 'gary23w/torflix';
const ANDROID = path.join(ROOT, 'android');
const OUTPUTS = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'release');
const DIST = path.join(ROOT, 'dist', 'android');

const args = process.argv.slice(2);
const publish = args.includes('--publish');
const notesAt = args.indexOf('--notes');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const notes = notesAt >= 0
  ? args[notesAt + 1]
  : `Torflix ${version} for Android TV: one APK per processor family. A Torflix already on a TV updates itself to it the next time it starts.`;

function run(command, commandArgs, options = {}) {
  const r = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    console.error(`[release] ${command} ${commandArgs.join(' ')} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

run(process.execPath, [path.join(ROOT, 'tools', 'android', 'build.mjs')]);
if (process.platform === 'win32') run('cmd', ['/c', path.join(ANDROID, 'gradlew.bat'), 'assembleRelease'], { cwd: ANDROID });
else run('./gradlew', ['assembleRelease'], { cwd: ANDROID });

const built = JSON.parse(await fsp.readFile(path.join(OUTPUTS, 'output-metadata.json'), 'utf8'));
await fsp.rm(DIST, { recursive: true, force: true });
await fsp.mkdir(DIST, { recursive: true });
const files = [];
for (const apk of built.elements) {
  const abi = apk.filters.find((f) => f.filterType === 'ABI')?.value;
  if (!abi) continue;
  if (apk.versionName !== version) throw new Error(`${apk.outputFile} is version ${apk.versionName}, not ${version}`);
  const file = path.join(DIST, `torflix-${version}-${abi}.apk`);
  await fsp.copyFile(path.join(OUTPUTS, apk.outputFile), file);
  files.push(file);
  console.log(`[release] ${path.relative(ROOT, file)} ${((await fsp.stat(file)).size / 1048576).toFixed(1)} MiB`);
}

if (!publish) {
  console.log(`[release] built; with --publish they go up as ${REPO} release v${version}`);
} else {
  run('gh', ['release', 'create', `v${version}`, ...files, '--repo', REPO, '--title', `Torflix ${version}`, '--notes', notes]);
}
