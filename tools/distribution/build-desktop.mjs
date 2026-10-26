// SPDX-License-Identifier: MIT OR Apache-2.0
// Run on the target OS/architecture so npm's native modules match the application.
import { build, Platform, Arch } from 'electron-builder';

const formats = {
  win32: ['nsis', 'zip'],
  linux: ['AppImage', 'deb', 'rpm'],
  darwin: ['dmg', 'zip'],
};
if (!formats[process.platform] || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error(`Unsupported build host: ${process.platform}/${process.arch}`);
}
// Windows x64 keeps the names its first release used; arm64 adds its own.
const winArch = process.arch === 'x64' ? '' : `-${process.arch}`;
// With 7-Zip's default filters, the arm64 installer installed every file except the .exe and
// .dll ones; its 7-Zip plugin decodes the x86 filter (BCJ), so arm64 uses that one.
if (process.platform === 'win32' && process.arch === 'arm64') process.env.ELECTRON_BUILDER_7Z_FILTER ??= 'BCJ';

await build({
  targets: Platform.current().createTarget(formats[process.platform], Arch[process.arch]),
  publish: 'never',
  config: {
    artifactName: 'Torflix-${version}-${os}-${arch}.${ext}',
    nsis: { artifactName: `Torflix-Setup-\${version}${winArch}.\${ext}` },
    win: { artifactName: `Torflix-\${version}-win${winArch}.\${ext}` },
    linux: {
      maintainer: 'Garrett Stimpson <info@garrettstimpson.ca>',
      synopsis: 'Torrent video streaming and downloads',
      category: 'Video',
    },
  },
});
