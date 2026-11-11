#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
#
# The Node runtime Torflix brings to a Raspberry Pi: Alpine Linux's Node 22 for 32-bit ARM,
# with the musl C library and every library it needs, into dist/pi-runtime/. A Pi from 2017
# may still run Raspbian Jessie, whose glibc (2.19) is far older than any current Node build
# accepts; started through its own musl loader, this Node needs nothing from the system's
# libraries. Alpine's package tool fetches the packages and checks their signatures.
#
# Runs on Linux x86_64 or aarch64 (it does not run the ARM binaries).
#
#   bash tools/pi/build-runtime.sh

set -euo pipefail

ALPINE=v3.22
NODE_VERSION=22.23.4
MIRROR=https://dl-cdn.alpinelinux.org/alpine/$ALPINE/main

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$ROOT/dist/pi-runtime-work"
OUT="$ROOT/dist/pi-runtime"
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in x86_64|aarch64) ;; *) echo "Unsupported build host: $HOST_ARCH" >&2; exit 1 ;; esac

rm -rf "$WORK" "$OUT"
mkdir -p "$WORK/tools" "$OUT/lib" "$OUT/icu"
cd "$WORK/tools"

# apk.static and Alpine's keys, from the release's packages for this machine.
curl -fsSL "$MIRROR/$HOST_ARCH/APKINDEX.tar.gz" | tar -xzO APKINDEX > APKINDEX
version_of() { awk -v p="$1" '/^P:/{n=substr($0,3)} /^V:/{if(n==p)print substr($0,3)}' APKINDEX; }
for p in apk-tools-static alpine-keys; do curl -fsSLO "$MIRROR/$HOST_ARCH/$p-$(version_of $p).apk"; done
tar -xzf apk-tools-static-*.apk sbin/apk.static 2>/dev/null
tar -xzf alpine-keys-*.apk usr/share/apk/keys 2>/dev/null

./sbin/apk.static --arch armv7 -X "$MIRROR" -U --root "$WORK/root" --initdb --usermode \
  --keys-dir "$WORK/tools/usr/share/apk/keys/armv7" --no-scripts \
  add "nodejs=$NODE_VERSION-r0" icu-data-full ca-certificates-bundle

R="$WORK/root"
cp "$R/usr/bin/node" "$OUT/node"
cp "$R/lib/ld-musl-armhf.so.1" "$OUT/lib/"
# Every library Node needs, and what those need in turn.
needed() { readelf -d "$1" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p'; }
locate() {
  for d in "$R/usr/lib" "$R/lib"; do if [ -e "$d/$1" ]; then echo "$d/$1"; return 0; fi; done
  echo "Not in the runtime: $1" >&2
  return 1
}
add() {
  local f
  for f in $(needed "$1"); do
    [ -e "$OUT/lib/$f" ] && continue
    if [ "$f" = libc.musl-armv7.so.1 ]; then ln -s ld-musl-armhf.so.1 "$OUT/lib/$f"; continue; fi
    cp -L "$(locate "$f")" "$OUT/lib/$f"
    add "$OUT/lib/$f"
  done
}
add "$OUT/node"
# OpenSSL's legacy provider has RC4, which BitTorrent's protocol encryption uses. With it (and
# `--openssl-legacy-provider`) bittorrent-protocol decrypts in OpenSSL, not in JavaScript: on a
# Raspberry Pi 3 that is 45 MB/s against 10, and decrypting no longer fills the engine's core.
mkdir -p "$OUT/ossl-modules"
cp "$R/usr/lib/ossl-modules/legacy.so" "$OUT/ossl-modules/"
add "$OUT/ossl-modules/legacy.so"
cp "$R"/usr/share/icu/*/icudt*.dat "$OUT/icu/"
cp -L "$R/etc/ssl/cert.pem" "$OUT/cert.pem"
# The licences of what is inside, for the package.
mkdir -p "$OUT/licenses"
for p in $(sed -n 's/^P://p' "$R/lib/apk/db/installed"); do
  l=$(awk -v p="$p" '/^P:/{n=substr($0,3)} /^L:/{if(n==p)print substr($0,3)}' "$R/lib/apk/db/installed")
  v=$(awk -v p="$p" '/^P:/{n=substr($0,3)} /^V:/{if(n==p)print substr($0,3)}' "$R/lib/apk/db/installed")
  echo "$p $v: $l" >> "$OUT/licenses/PACKAGES"
done
cp -r "$R/usr/share/licenses/." "$OUT/licenses/" 2>/dev/null || true

rm -rf "$WORK"
echo "Node $NODE_VERSION for 32-bit ARM (Alpine $ALPINE, musl) in $OUT: $(du -sh "$OUT" | cut -f1)"
