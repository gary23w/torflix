// SPDX-License-Identifier: MIT OR Apache-2.0
// Generate only packages whose downloads are already present in the GitHub release.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable numeric version is required');
const repo = 'gary23w/torflix';
const homepage = `https://github.com/${repo}`;
const release = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/releases/tags/v${version}`], { encoding: 'utf8' }));
const output = path.join(root, 'packaging');
const id = 'GarrettStimpson.Torflix';
const quote = value => JSON.stringify(value);
const asset = name => {
  const found = release.assets.find(entry => entry.name === name);
  if (!found || !/^sha256:[a-f0-9]{64}$/.test(found.digest || '')) throw new Error(`Missing published artifact or SHA-256: ${name}`);
  if (!found.browser_download_url.startsWith(`${homepage}/releases/download/v${version}/`)) throw new Error('Unexpected download origin');
  return { url: found.browser_download_url, sha256: found.digest.slice(7) };
};
async function write(relative, content) {
  const file = path.join(output, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  console.log(path.relative(root, file));
}
const header = type => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.12.0.schema.json\n\nPackageIdentifier: ${id}\nPackageVersion: ${quote(version)}\n`;
const footer = type => `ManifestType: ${type}\nManifestVersion: 1.12.0\n`;
const installer = asset(`Torflix-Setup-${version}.exe`);
const winget = `winget/${version}/${id}`;
await write(`${winget}.yaml`, header('version') + `DefaultLocale: en-US\n` + footer('version'));
await write(`${winget}.locale.en-US.yaml`, header('defaultLocale') + `PackageLocale: en-US
Publisher: Garrett Stimpson
PublisherUrl: https://github.com/gary23w
PublisherSupportUrl: ${homepage}/issues
Author: Garrett Stimpson
PackageName: Torflix
PackageUrl: ${homepage}
License: MIT OR Apache-2.0
LicenseUrl: ${homepage}#license
ShortDescription: Stream torrent videos while they download.
Description: |-
  Torflix is a torrent streaming and download application with a built-in video player.
  Browse and search, open magnet links and torrent files, watch video as its pieces
  arrive, and resume from your library. Includes subtitles, bandwidth and cache controls.
  Desktop Dolby and DTS audio playback can use a separately installed FFmpeg.
  Only download or stream content you are authorized to access.
Moniker: torflix
Tags:
- bittorrent
- media-player
- streaming
- torrent
- video
ReleaseNotesUrl: ${homepage}/releases/tag/v${version}
` + footer('defaultLocale'));
await write(`${winget}.installer.yaml`, header('installer') + `InstallerType: nullsoft
Scope: user
InstallModes:
- silent
- silentWithProgress
InstallerSwitches:
  Silent: /S --noLaunch
  SilentWithProgress: /S --noLaunch
UpgradeBehavior: install
ReleaseDate: ${release.published_at.slice(0, 10)}
Installers:
- Architecture: x64
  InstallerUrl: ${installer.url}
  InstallerSha256: ${installer.sha256.toUpperCase()}
ManifestType: installer
ManifestVersion: 1.12.0
`);

const zipName = release.assets.some(entry => entry.name === `Torflix-${version}-win-x64.zip`)
  ? `Torflix-${version}-win-x64.zip` : `Torflix-${version}-win.zip`;
if (release.assets.some(entry => entry.name === zipName)) {
  const zip = asset(zipName);
  const scoop = {
    version,
    description: 'Torrent video streaming and downloads with a built-in player.',
    homepage,
    license: 'MIT OR Apache-2.0',
    suggest: { FFmpeg: 'main/ffmpeg' },
    architecture: { '64bit': { url: zip.url, hash: zip.sha256 } },
    bin: 'Torflix.exe',
    shortcuts: [['Torflix.exe', 'Torflix']],
    checkver: { github: homepage },
    autoupdate: { architecture: { '64bit': { url: `${homepage}/releases/download/v$version/${zipName.replaceAll(version, '$version')}` } } },
  };
  await write('scoop/torflix.json', JSON.stringify(scoop, null, 4) + '\n');
}

await write('chocolatey/torflix.nuspec', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2015/06/nuspec.xsd">
  <metadata>
    <id>torflix</id>
    <version>${version}</version>
    <title>Torflix</title>
    <authors>Garrett Stimpson; The TorrentPlayer Contributors</authors>
    <owners>gary23w</owners>
    <projectUrl>${homepage}</projectUrl>
    <iconUrl>https://raw.githubusercontent.com/${repo}/v${version}/assets/icon.png</iconUrl>
    <licenseUrl>${homepage}#license</licenseUrl>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
    <projectSourceUrl>${homepage}</projectSourceUrl>
    <bugTrackerUrl>${homepage}/issues</bugTrackerUrl>
    <docsUrl>${homepage}#readme</docsUrl>
    <tags>torflix torrent bittorrent streaming video player</tags>
    <summary>Torrent streaming and downloads with a built-in video player.</summary>
    <description>Torflix plays torrent videos as they download. Open magnet links and torrent files, browse and search, use subtitles, and resume from your library. Includes bandwidth and cache controls. FFmpeg is optional for desktop Dolby and DTS audio. Only access content you are authorized to download or stream.</description>
    <releaseNotes>${homepage}/releases/tag/v${version}</releaseNotes>
  </metadata>
  <files><file src="tools/**" target="tools" /></files>
</package>
`);
await write('chocolatey/tools/chocolateyinstall.ps1', `$ErrorActionPreference = 'Stop'
$packageArgs = @{
    packageName    = $env:ChocolateyPackageName
    fileType       = 'exe'
    url64bit       = '${installer.url}'
    checksum64     = '${installer.sha256}'
    checksumType64 = 'sha256'
    silentArgs     = '/S /allusers --noLaunch'
    validExitCodes = @(0, 1641, 3010)
    softwareName   = 'Torflix*'
}
Install-ChocolateyPackage @packageArgs
`);
await write('listing.json', JSON.stringify({
  name: 'Torflix', version, publisher: 'Garrett Stimpson', contactEmail: pkg.author.email,
  homepage, source: homepage, support: `${homepage}/issues`, license: pkg.license,
  shortDescription: 'Torrent video streaming and downloads with a built-in player.',
  platforms: ['Windows x64', 'Android TV 7.0+'],
  downloads: release.assets.map(({ name, browser_download_url, digest, size }) => ({ name, url: browser_download_url, digest, size })),
}, null, 2) + '\n');
