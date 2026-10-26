# Distribution packages

Torflix 0.3.0 is available from [GitHub Releases](https://github.com/gary23w/torflix/releases/tag/v0.3.0)
and [SourceForge](https://sourceforge.net/projects/torflix/files/v0.3.0/). `SHA256SUMS` records the
release download checksums. Windows builds are unsigned; macOS builds are not Apple notarized.

## Package managers

| Channel | Installation or current status |
| --- | --- |
| Scoop | `scoop bucket add torflix https://github.com/gary23w/scoop-torflix`, then `scoop install torflix/torflix` |
| Homebrew | `brew tap gary23w/torflix`, then `brew install --cask torflix` |
| WinGet | [Catalog submission](https://github.com/microsoft/winget-pkgs/pull/462443) is awaiting validation and review. The Microsoft individual CLA is accepted. |
| Chocolatey | `torflix.0.3.0.nupkg` is in the GitHub release. Gallery upload has not completed. |
| Nix | This repository supplies a flake for x86_64 Linux. Run `nix run github:gary23w/torflix#torflix` once this change is merged. It uses Nixpkgs Electron 44, patches the packaged native modules, and includes FFmpeg. It is not a Nixpkgs catalog entry. |
| Arch Linux | Build the recipe in `packaging/aur` with `makepkg -si` as a normal user. It repackages the checksum-verified Debian release. The recipe has not been uploaded to AUR. |
| Debian / Ubuntu | Download the `.deb` release, then `sudo apt install ./Torflix-0.3.0-linux-amd64.deb`. No hosted apt repository is configured. |
| Fedora | Download the `.rpm` release, then `sudo dnf install ./Torflix-0.3.0-linux-x86_64.rpm`. No hosted RPM repository is configured. |

The Scoop bucket and Homebrew tap are maintained by the publisher. The main Scoop Extras
and Homebrew catalogs have project popularity requirements this release does not meet.
Flathub's current contribution policy forbids AI-assisted manifests and automated submissions,
so no Flathub request has been made. Snap Store and AUR publication require publisher accounts.

## Maintaining a release

1. Publish the native binaries and portable ZIP to the matching `v<version>` GitHub release.
2. Run `npm run distribution:generate`. It reads GitHub's SHA-256 digests and generates
   WinGet, Scoop, Chocolatey, Homebrew, Nix release metadata and the Arch recipe.
3. Review the generated diff. Existing released installers must keep their hashes unless a
   deliberate coordinated update is made to every dependent catalog and mirror.
4. Copy `scoop/torflix.json` to the publisher's `scoop-torflix` bucket and
   `homebrew/torflix.rb` to `homebrew-torflix/Casks/torflix.rb`.
5. Pack Chocolatey with the official Chocolatey CLI; submit the WinGet manifests upstream.
   Use publisher credentials through each service's supported login process.
6. Run the package manager validation workflow. It builds the Nix derivation and Arch package
   on Linux, generates `.SRCINFO` with `makepkg`, and checks the Homebrew install on macOS.
7. Update the SourceForge release mirror and platform default downloads.

Native module binaries must match the target operating system and CPU. Desktop release builds
run on their target hosts; a Windows `node_modules` tree cannot produce working Linux/macOS
native modules. Do not disable Electron's sandbox or Gatekeeper to work around packaging errors.
