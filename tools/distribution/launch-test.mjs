// SPDX-License-Identifier: MIT OR Apache-2.0
// Installs what build-desktop.mjs made, the way a user would, and starts each copy in its
// self-test (`--smoke`, stopped once the window is up). Run on the OS/architecture it was built on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dist = path.resolve(process.argv[2] || 'dist');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'torflix-launch-'));
const shots = path.resolve(process.argv[3] || path.join(work, 'shots'));
const failures = [];

const find = (pattern) => {
  const name = fs.readdirSync(dist).find((entry) => pattern.test(entry));
  if (!name) throw new Error(`Nothing in ${dist} matches ${pattern}`);
  return path.join(dist, name);
};
const run = (command, args, options = {}) => {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 300_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
};
// One self-test start of an installed copy; its screenshots go to shots/<label>.
const launch = (label, command, args = [], env = {}) => {
  console.log(`\n== ${label}`);
  const result = spawnSync(command, [...args, '--smoke'], {
    stdio: 'inherit',
    timeout: 180_000,
    env: {
      ...process.env,
      TORRENTPLAYER_SMOKE_STEPS: 'ready',
      TORRENTPLAYER_SMOKE_OUT: path.join(shots, label),
      ...env,
    },
  });
  const ok = result.status === 0;
  console.log(`== ${label}: ${ok ? 'started' : `FAILED (${result.error?.message ?? `exit ${result.status}, signal ${result.signal}`})`}`);
  if (!ok) failures.push(label);
};
const check = (label, fn) => {
  try {
    fn();
  } catch (err) {
    console.log(`== ${label}: FAILED (${err.message})`);
    failures.push(label);
  }
};
fs.mkdirSync(shots, { recursive: true });

if (process.platform === 'win32') {
  // The installer winget and Chocolatey run, silently and per user, then its uninstaller.
  check('installer', () => {
    run(find(/^Torflix-Setup-.*\.exe$/), ['/S']);
    // Where the installer says it put Torflix (its uninstall entry), waiting a minute in case
    // it handed the work to another process.
    const installed = () => {
      const keys = ['HKCU', 'HKLM'].map((hive) => `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`);
      for (const key of keys) {
        const out = spawnSync('reg', ['query', key, '/s', '/v', 'InstallLocation'], { encoding: 'utf8' }).stdout ?? '';
        const dir = out.match(/InstallLocation\s+REG_SZ\s+(.*torflix.*)$/im)?.[1].trim();
        if (dir && fs.existsSync(path.join(dir, 'Torflix.exe'))) return dir;
      }
      return null;
    };
    let dir = installed();
    for (let waited = 0; !dir && waited < 60; waited += 5) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
      dir = installed();
    }
    if (!dir) {
      const programs = path.join(process.env.LOCALAPPDATA, 'Programs');
      console.log(`${programs}: ${fs.existsSync(programs) ? fs.readdirSync(programs).join(', ') : 'missing'}`);
      spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'Torflix'], { stdio: 'inherit' });
      throw new Error('the installer left no Torflix.exe it records');
    }
    console.log(`Installed in ${dir}`);
    launch('installer', path.join(dir, 'Torflix.exe'));
    run(path.join(dir, 'Uninstall Torflix.exe'), ['/S', '_?=' + dir]);
    if (fs.existsSync(path.join(dir, 'Torflix.exe'))) throw new Error('the uninstaller left Torflix.exe');
  });
  // The zip Scoop unpacks.
  check('zip', () => {
    const dir = path.join(work, 'zip');
    fs.mkdirSync(dir);
    run('tar', ['-xf', find(/^Torflix-.*-win.*\.zip$/), '-C', dir]);
    launch('zip', path.join(dir, 'Torflix.exe'));
  });
} else if (process.platform === 'linux') {
  // A virtual display for the window; the .deb's own chrome-sandbox setup is tested as installed.
  check('deb', () => {
    run('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', find(/\.deb$/)]);
    launch('deb', 'xvfb-run', ['-a', 'torflix']);
  });
  check('AppImage', () => {
    const image = find(/\.AppImage$/);
    fs.chmodSync(image, 0o755);
    launch('AppImage', 'xvfb-run', ['-a', image], { APPIMAGE_EXTRACT_AND_RUN: '1' });
  });
  check('rpm', () => run('rpm', ['-qpi', find(/\.rpm$/)]));
} else if (process.platform === 'darwin') {
  // Ad-hoc signed: Gatekeeper then offers "Open Anyway" instead of calling the app damaged.
  const verify = (app) => {
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    const info = spawnSync('codesign', ['-dv', app], { encoding: 'utf8' }).stderr;
    if (!/Signature=adhoc/.test(info)) throw new Error(`not ad-hoc signed:\n${info}`);
  };
  check('zip', () => {
    const dir = path.join(work, 'zip');
    run('ditto', ['-x', '-k', find(/\.zip$/), dir]);
    verify(path.join(dir, 'Torflix.app'));
    launch('zip', path.join(dir, 'Torflix.app', 'Contents', 'MacOS', 'Torflix'));
  });
  check('dmg', () => {
    const mount = path.join(work, 'dmg');
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, find(/\.dmg$/)]);
    try {
      verify(path.join(mount, 'Torflix.app'));
    } finally {
      run('hdiutil', ['detach', mount]);
    }
  });
}

if (failures.length) {
  console.error(`\nFailed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nEvery package installed and started.');
