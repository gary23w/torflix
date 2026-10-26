#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
#
# Builds the Node.js the Android app runs its backend with, from the official source with
# Node's own android-configure, and puts it where the APK picks it up:
#
#   android/app/src/main/jniLibs/<abi>/libnode.so
#
# (A program shipped as a ".so" in jniLibs is extracted into the app's native library folder,
# the one place Android lets an app start a program from.)
#
# Run inside WSL Ubuntu. The build tools, once, as root:
#
#   wsl -u root -- apt-get install -y python3 g++ g++-multilib make unzip curl xz-utils file
#
# then, from the project folder:
#
#   wsl -- bash tools/android/build-node.sh          # arm64, then arm
#   wsl -- bash tools/android/build-node.sh arm      # one architecture
#   wsl -- bash tools/android/build-node.sh x86_64   # for the Android TV emulator
#
# g++-multilib is for armv7: V8's build tools run on this machine and must be 32-bit too.
# About 45-60 minutes per architecture on 12 cores. Sources and builds stay in ~/torflix-node.

set -euo pipefail

NODE_VERSION=22.23.4
NODE_SHA256=7b9adc82d612d0a2a863d96c46de2292552e250cee51956ebbe0146c42aacae9
NDK_VERSION=r27d
NDK_SHA1=22105e410cf29afcf163760cc95522b9fb981121
API_LEVEL=24

PROJECT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${TORFLIX_NODE_WORK:-$HOME/torflix-node}"
JOBS="${JOBS:-$(nproc)}"
ARCHES=("$@")
[ ${#ARCHES[@]} -eq 0 ] && ARCHES=(arm64 arm)

mkdir -p "$WORK"
cd "$WORK"

if [ ! -d "android-ndk-$NDK_VERSION" ]; then
  curl -fL -o ndk.zip "https://dl.google.com/android/repository/android-ndk-$NDK_VERSION-linux.zip"
  echo "$NDK_SHA1  ndk.zip" | sha1sum -c -
  unzip -q ndk.zip
  rm ndk.zip
fi
NDK="$WORK/android-ndk-$NDK_VERSION"
STRIP="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip"

# What `android-configure patch` does (android-patches/trap-handler.h.patch), by content, since
# that patch no longer applies to this version's header: V8's WebAssembly trap handler is
# turned off. Android does not allow it anyway, and with it on, V8's snapshot tool (built for
# this machine, simulating ARM) fails to link.
disable_trap_handler() {
  python3 - "$1" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
first = '// X64 on Linux, Windows, MacOS, FreeBSD.'
last = '#define V8_TRAP_HANDLER_SUPPORTED false\n#endif'
if first in text:
    start = text.index(first)
    end = text.index(last, start) + len(last)
    text = text[:start] + '#define V8_TRAP_HANDLER_SUPPORTED false' + text[end:]
    open(path, 'w').write(text)
PY
  grep -q '^#define V8_TRAP_HANDLER_SUPPORTED false$' "$1"
}

# OpenSSL keeps the folder it was built in (its modules folder, never used on Android) inside the
# executable. That folder is under this machine's home, so it is replaced with a neutral path of
# the same length (/build/./././...).
neutral_paths() {
  python3 - "$1" "$WORK" <<'PY'
import sys
path, work = sys.argv[1], sys.argv[2].encode()
neutral = (b'/build' + b'/.' * len(work))[:len(work)]
data = open(path, 'rb').read()
open(path, 'wb').write(data.replace(work, neutral))
PY
  if grep -qF "$WORK" "$1"; then
    echo "$1 still names $WORK" >&2
    exit 1
  fi
}

TARBALL="node-v$NODE_VERSION.tar.xz"
[ -f "$TARBALL" ] || curl -fL -o "$TARBALL" "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
echo "$NODE_SHA256  $TARBALL" | sha256sum -c -

for ARCH in "${ARCHES[@]}"; do
  # V8's own build tools (torque, mksnapshot, ...) are compiled for this machine and run during
  # the build. android-configure sets only the Android compilers, so without these the tools
  # are built for Android too. For a 32-bit target they must be 32-bit as well.
  case "$ARCH" in
    arm64)
      ABI=arm64-v8a
      TRIPLE=aarch64-linux-android
      HOST_FLAGS=""
      ;;
    arm)
      ABI=armeabi-v7a
      TRIPLE=armv7a-linux-androideabi
      HOST_FLAGS=" -m32"
      ;;
    x86_64)
      ABI=x86_64
      TRIPLE=x86_64-linux-android
      HOST_FLAGS=""
      ;;
    *)
      echo "Unknown architecture: $ARCH (arm64, arm or x86_64)" >&2
      exit 2
      ;;
  esac
  export CC_host="gcc$HOST_FLAGS" CXX_host="g++$HOST_FLAGS" LINK_host="g++$HOST_FLAGS" AR_host=ar
  # One source tree per architecture, so each keeps its own configuration and objects.
  SRC="$WORK/node-v$NODE_VERSION-$ARCH"
  if [ ! -d "$SRC" ]; then
    mkdir -p "$SRC"
    tar -xJf "$TARBALL" -C "$SRC" --strip-components=1
    disable_trap_handler "$SRC/deps/v8/src/trap-handler/trap-handler.h"
  fi
  echo "== Node $NODE_VERSION for $ABI (Android $API_LEVEL+), $JOBS jobs"
  # zlib asks the NDK's cpufeatures library for the CPU's CRC32 and PMULL instructions on
  # Android, but Node's build never compiles that library: it is linked in here. And the C++
  # library goes inside the executable: Android has no libc++_shared.so of its own, and a
  # program started by an app does not reliably find one shipped beside it.
  CPUFEATURES="$WORK/cpu-features-$ARCH.o"
  "$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/$TRIPLE$API_LEVEL-clang" -c -O2 -fPIC \
    -I"$NDK/sources/android/cpufeatures" "$NDK/sources/android/cpufeatures/cpu-features.c" -o "$CPUFEATURES"
  export LDFLAGS="$CPUFEATURES -static-libstdc++"
  # Only the executable: Node's own C++ tests (cctest) use aligned_alloc, which Android has
  # only from API 28.
  (cd "$SRC" && ./android-configure "$NDK" "$API_LEVEL" "$ARCH" && make -j"$JOBS" -C out BUILDTYPE=Release node)
  OUT="$PROJECT/android/app/src/main/jniLibs/$ABI"
  mkdir -p "$OUT"
  "$STRIP" -o "$OUT/libnode.so" "$SRC/out/Release/node"
  neutral_paths "$OUT/libnode.so"
  file "$OUT/libnode.so"
  ls -l "$OUT/libnode.so"
  # Only Android's own libraries may be needed (libc, libm, libdl, liblog).
  NEEDED=$("$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf" -d "$OUT/libnode.so" | grep NEEDED | grep -vE '\[lib(c|m|dl|log)\.so\]' || true)
  if [ -n "$NEEDED" ]; then
    echo "libnode.so needs libraries Android does not have:" >&2
    echo "$NEEDED" >&2
    exit 1
  fi
done
