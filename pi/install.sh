#!/bin/bash
# SPDX-License-Identifier: MIT OR Apache-2.0
#
# Installs Torflix for a Raspberry Pi's console from this folder: copies it to /opt/torflix,
# and adds Torflix to RetroPie's Ports when RetroPie is there. Run it again to update.
#
#   ./install.sh
set -e

here="$(cd "$(dirname "$0")" && pwd)"
dest=/opt/torflix
user="${SUDO_USER:-$USER}"
home="$(getent passwd "$user" | cut -d: -f6)"

case "$(uname -m)" in
  armv7l|armv8l|aarch64) ;;
  *) echo "Torflix needs a Raspberry Pi 2 or newer; this is $(uname -m)." >&2; exit 1 ;;
esac
if [ ! -e /opt/vc/lib/libbcm_host.so ]; then
  echo "Torflix for the console plays through the Pi's legacy video driver, which this system does not have." >&2
  echo "On Raspberry Pi OS with a desktop, install the armv7l (or arm64) .deb instead." >&2
  exit 1
fi

missing=""
python3 -c 'import pygame' 2>/dev/null || missing="$missing python3-pygame"
command -v omxplayer >/dev/null || missing="$missing omxplayer"
if [ -n "$missing" ]; then
  echo "Installing$missing"
  sudo apt-get install -y $missing
fi

echo "Copying Torflix to $dest"
sudo rm -rf "$dest.new"
sudo mkdir -p "$dest.new"
sudo cp -a "$here/." "$dest.new/"
sudo chown -R root:root "$dest.new"
sudo rm -rf "$dest"
sudo mv "$dest.new" "$dest"

ports="$home/RetroPie/roms/ports"
if [ -d "$ports" ]; then
  cat > "$ports/Torflix.sh" <<'EOF'
#!/bin/bash
/opt/torflix/torflix.sh
EOF
  chmod 755 "$ports/Torflix.sh"
  [ "$(id -u)" = 0 ] && chown "$user:" "$ports/Torflix.sh"
  echo "Added Torflix to RetroPie's Ports. Restart EmulationStation to see it there."
else
  echo "Start Torflix with /opt/torflix/torflix.sh (from the console, not over SSH)."
fi
