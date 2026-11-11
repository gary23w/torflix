#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
#
# Checks a Raspberry Pi package without a Pi: its Node starts the engine (through qemu-arm on
# another machine), the bridge answers with the engine's version, and the TV shell compiles.
# The picture and omxplayer need a real Pi.
#
#   bash tools/pi/smoke.sh dist/Torflix-<version>-raspberry-pi.tar.gz

set -euo pipefail

archive="$(realpath "$1")"
work="$(mktemp -d)"
pid=
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$work"' EXIT
tar -xzf "$archive" -C "$work" --strip-components=1
cd "$work"

python3 -m py_compile torflix-tv.py
for f in torflix.sh install.sh uninstall.sh; do bash -n "$f"; done

export NODE_ICU_DATA=$work/runtime/icu SSL_CERT_FILE=$work/runtime/cert.pem OPENSSL_MODULES=$work/runtime/ossl-modules
token=$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')
mkdir -p data downloads
TORFLIX_TOKEN=$token TORFLIX_DATA=$work/data TORFLIX_DOWNLOADS=$work/downloads \
  runtime/lib/ld-musl-armhf.so.1 --library-path runtime/lib runtime/node --openssl-legacy-provider app/backend.mjs \
  > backend.log 2>&1 &
pid=$!
for _ in $(seq 1 180); do grep -q TORFLIX_READY backend.log && break; kill -0 "$pid" 2>/dev/null || break; sleep 1; done
port=$(sed -n 's/.*TORFLIX_READY {"port":\([0-9]*\)}.*/\1/p' backend.log)
if [ -z "$port" ]; then cat backend.log; echo "The engine did not start." >&2; exit 1; fi

rpc() { curl -fsS -H "Cookie: tp=$token" -H 'Content-Type: application/json' -d "${2:-[]}" "http://127.0.0.1:$port/rpc/$1"; }
info=$(rpc appInfo)
echo "$info"
grep -q '"ok":true' <<< "$info"
# Native RC4 (OpenSSL's legacy provider) is what keeps a Pi's core free while it downloads.
runtime/lib/ld-musl-armhf.so.1 --library-path runtime/lib runtime/node --openssl-legacy-provider \
  -e "require('crypto').createCipheriv('rc4', Buffer.alloc(16), ''); console.log('native RC4 available')" \
  </dev/null 2>&1 | grep -q 'native RC4 available' || { echo 'No native RC4' >&2; exit 1; }
grep -q '"downloadLimitKib":2048' <<< "$(rpc getSettings)" || { echo 'The first-run download cap is missing' >&2; exit 1; }
echo "Raspberry Pi package: the engine starts and answers."
