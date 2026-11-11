#!/bin/bash
# SPDX-License-Identifier: MIT OR Apache-2.0
#
# Removes Torflix from /opt/torflix and RetroPie's Ports. Settings, Continue watching and
# downloaded videos stay unless `--purge` is given.
#
#   /opt/torflix/uninstall.sh [--purge]
set -e

user="${SUDO_USER:-$USER}"
home="$(getent passwd "$user" | cut -d: -f6)"

rm -f "$home/RetroPie/roms/ports/Torflix.sh"
sudo rm -rf /opt/torflix
if [ "$1" = --purge ]; then
  rm -rf "$home/.config/torflix" "$home/Downloads/Torflix"
  echo "Torflix, its settings and its downloads are removed."
else
  echo "Torflix is removed. Its settings ($home/.config/torflix) and downloads ($home/Downloads/Torflix) are kept."
fi
