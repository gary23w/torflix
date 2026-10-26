// SPDX-License-Identifier: MIT OR Apache-2.0
// Run on the target OS/architecture so npm's native modules match the application.
import { build, Platform, Arch } from 'electron-builder';

const formats = {
  win32: ['zip'],
  linux: ['AppImage', 'deb', 'rpm'],
  darwin: ['dmg', 'zip'],
};
if (!formats[process.platform] || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error(`Unsupported build host: ${process.platform}/${process.arch}`);
}

await build({
  targets: Platform.current().createTarget(formats[process.platform], Arch[process.arch]),
  publish: 'never',
  config: {
    artifactName: 'Torflix-${version}-${os}-${arch}.${ext}',
    linux: {
      maintainer: 'Garrett Stimpson <info@garrettstimpson.ca>',
      synopsis: 'Torrent video streaming and downloads',
      category: 'Video',
    },
  },
});
