#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
#
# Builds the audio decoders the TV player falls back on when the TV has none of its own for a
# video's sound (Dolby Digital and Digital Plus, TrueHD, DTS): FFmpeg's, through Media3's FFmpeg
# extension, and puts them where the APK picks them up:
#
#   android/app/src/main/jniLibs/<abi>/libffmpegJNI.so
#   android/app/src/main/ffmpeg/java/androidx/media3/decoder/ffmpeg/   (the extension's classes)
#
# Many TV boxes have no decoder an app may use for these, and E-AC3 (Dolby Digital Plus) is the
# usual sound of WEB releases: without this, those videos play silent there.
#
# FFmpeg is built with those decoders only and none of its GPL or nonfree parts, so it is under
# the LGPL 2.1 or later; the extension is under the Apache License 2.0. Run inside WSL Ubuntu,
# from the project folder (it uses build-node.sh's NDK, or fetches the same one):
#
#   wsl -- bash tools/android/build-ffmpeg.sh          # arm, arm64 and x86_64
#   wsl -- bash tools/android/build-ffmpeg.sh arm      # one architecture
#
# A few minutes per architecture. Sources and builds stay in ~/torflix-ffmpeg.

set -euo pipefail

FFMPEG_VERSION=6.0.1
# Checked against the release signature (FFmpeg release signing key FCF986EA15E6E293A5644F10B4322F04D67658D8).
FFMPEG_SHA256=9b16b8731d78e596b4be0d720428ca42df642bb2d78342881ff7f5bc29fc9623
# The Media3 the app is built with (android/app/build.gradle.kts); its extension wants FFmpeg 6.0.
MEDIA3_VERSION=1.11.1
NDK_VERSION=r27d
NDK_SHA1=22105e410cf29afcf163760cc95522b9fb981121
API_LEVEL=24
DECODERS=(ac3 eac3 dca truehd mlp)

# The extension's files this build uses, by path in androidx/media, with their checksums.
MEDIA3_DIR=libraries/decoder_ffmpeg/src/main
declare -A MEDIA3_FILES=(
  [jni/ffmpeg_jni.cc]=68e6919f91cf810a86ee44ca8d045e60df2e45b31a75ed2985b8100043e4ad4b
  [java/androidx/media3/decoder/ffmpeg/FfmpegAudioDecoder.java]=64b5ff45fd9f60b6775d542bda141698e5d32cacdd04ddd96141e86f2c0a51f8
  [java/androidx/media3/decoder/ffmpeg/FfmpegAudioRenderer.java]=230bcaef26ddd233f7f2ac0cdd7a5896d98e7d8dd8d4c9b2ea1942c483b05c48
  [java/androidx/media3/decoder/ffmpeg/FfmpegDecoderException.java]=9e73968d0802b2d7f8add911ec4dc5a6e621777e997eca74332e173c5463ad7a
  [java/androidx/media3/decoder/ffmpeg/FfmpegLibrary.java]=a0843232be53210aefe97d8bc0a0268ac781cc7ce72e2d47bf42cd07f8048880
  [java/androidx/media3/decoder/ffmpeg/package-info.java]=1d75d02151fcec7a1c0036ee4a216e885ae91e1f85e8c9ddfbd72b4def6709be
)

PROJECT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${TORFLIX_FFMPEG_WORK:-$HOME/torflix-ffmpeg}"
NODE_WORK="${TORFLIX_NODE_WORK:-$HOME/torflix-node}"
JOBS="${JOBS:-$(nproc)}"
ARCHES=("$@")
[ ${#ARCHES[@]} -eq 0 ] && ARCHES=(arm arm64 x86_64)

mkdir -p "$WORK"
cd "$WORK"

NDK="$NODE_WORK/android-ndk-$NDK_VERSION"
if [ ! -d "$NDK" ]; then
  NDK="$WORK/android-ndk-$NDK_VERSION"
  if [ ! -d "$NDK" ]; then
    curl -fL -o ndk.zip "https://dl.google.com/android/repository/android-ndk-$NDK_VERSION-linux.zip"
    echo "$NDK_SHA1  ndk.zip" | sha1sum -c -
    unzip -q ndk.zip
    rm ndk.zip
  fi
fi
BIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"

FFMPEG_SRC="$WORK/ffmpeg-$FFMPEG_VERSION"
if [ ! -d "$FFMPEG_SRC" ]; then
  [ -f "ffmpeg-$FFMPEG_VERSION.tar.xz" ] || curl -fL -o "ffmpeg-$FFMPEG_VERSION.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
  echo "$FFMPEG_SHA256  ffmpeg-$FFMPEG_VERSION.tar.xz" | sha256sum -c -
  tar -xJf "ffmpeg-$FFMPEG_VERSION.tar.xz"
fi

MEDIA3="$WORK/media3-$MEDIA3_VERSION"
for path in "${!MEDIA3_FILES[@]}"; do
  if [ ! -f "$MEDIA3/$path" ]; then
    mkdir -p "$(dirname "$MEDIA3/$path")"
    curl -fsSL -o "$MEDIA3/$path" "https://raw.githubusercontent.com/androidx/media/$MEDIA3_VERSION/$MEDIA3_DIR/$path"
  fi
  echo "${MEDIA3_FILES[$path]}  $MEDIA3/$path" | sha256sum -c --quiet -
done

# The extension's classes, unchanged, where the app's Gradle build compiles them.
JAVA_OUT="$PROJECT/android/app/src/main/ffmpeg/java/androidx/media3/decoder/ffmpeg"
rm -rf "$PROJECT/android/app/src/main/ffmpeg"
mkdir -p "$JAVA_OUT"
cp "$MEDIA3"/java/androidx/media3/decoder/ffmpeg/*.java "$JAVA_OUT/"

for arch in "${ARCHES[@]}"; do
  case "$arch" in
    arm)
      ABI=armeabi-v7a TRIPLE=armv7a-linux-androideabi FF_ARCH=arm FF_CPU=armv7-a
      FF_EXTRA=(--extra-cflags="-march=armv7-a -mfloat-abi=softfp" --extra-ldflags="-Wl,--fix-cortex-a8")
      LINK_EXTRA=() ;;
    arm64)
      ABI=arm64-v8a TRIPLE=aarch64-linux-android FF_ARCH=aarch64 FF_CPU=armv8-a FF_EXTRA=()
      # As Media3's CMakeLists.txt does for arm64 with NDK 23 and later.
      LINK_EXTRA=(-Wl,-Bsymbolic) ;;
    x86_64)
      ABI=x86_64 TRIPLE=x86_64-linux-android FF_ARCH=x86_64 FF_CPU=x86-64 FF_EXTRA=(--disable-asm)
      LINK_EXTRA=() ;;
    *) echo "unknown architecture: $arch (arm, arm64 or x86_64)" >&2; exit 1 ;;
  esac
  CC="$BIN/$TRIPLE$API_LEVEL-clang"
  BUILD="$WORK/build-$ABI"
  PREFIX="$WORK/out-$ABI"
  rm -rf "$BUILD" "$PREFIX"
  mkdir -p "$BUILD"

  # Media3's build_ffmpeg.sh options, with the decoders above and nothing else.
  enabled=()
  for d in "${DECODERS[@]}"; do enabled+=(--enable-decoder="$d"); done
  (cd "$BUILD" && "$FFMPEG_SRC/configure" \
    --prefix="$PREFIX" \
    --target-os=android --arch="$FF_ARCH" --cpu="$FF_CPU" \
    --cross-prefix="$BIN/$TRIPLE$API_LEVEL-" --cc="$CC" \
    --nm="$BIN/llvm-nm" --ar="$BIN/llvm-ar" --ranlib="$BIN/llvm-ranlib" --strip="$BIN/llvm-strip" \
    --enable-static --disable-shared --enable-pic \
    --disable-doc --disable-programs --disable-everything \
    --disable-avdevice --disable-avformat --disable-swscale --disable-postproc --disable-avfilter \
    --disable-symver --disable-v4l2-m2m --disable-vulkan \
    --enable-swresample \
    "${enabled[@]}" "${FF_EXTRA[@]}" > configure.log)
  grep -q '^License: LGPL' "$BUILD/configure.log" || { echo "FFmpeg is not configured as LGPL" >&2; exit 1; }
  make -C "$BUILD" -j"$JOBS" > "$BUILD/make.log"
  make -C "$BUILD" install-libs install-headers > /dev/null

  # Media3's JNI wrapper, linked against those libraries (what its CMakeLists.txt does).
  OUT="$PROJECT/android/app/src/main/jniLibs/$ABI"
  mkdir -p "$OUT"
  "$BIN/$TRIPLE$API_LEVEL-clang++" -shared -fPIC -O2 -std=c++11 \
    -fvisibility=hidden -fvisibility-inlines-hidden \
    -I"$PREFIX/include" "$MEDIA3/jni/ffmpeg_jni.cc" \
    -L"$PREFIX/lib" -lswresample -lavcodec -lavutil -landroid -llog -lm \
    -static-libstdc++ -Wl,--gc-sections -Wl,-z,max-page-size=16384 "${LINK_EXTRA[@]}" \
    -o "$OUT/libffmpegJNI.so"
  "$BIN/llvm-strip" --strip-unneeded "$OUT/libffmpegJNI.so"

  # Only the system libraries every Android has.
  needed="$("$BIN/llvm-readelf" -d "$OUT/libffmpegJNI.so" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' | tr '\n' ' ')"
  for lib in $needed; do
    case "$lib" in
      libc.so|libm.so|libdl.so|liblog.so|libandroid.so) ;;
      *) echo "libffmpegJNI.so ($ABI) needs $lib, which the TV does not have" >&2; exit 1 ;;
    esac
  done
  echo "$ABI: $(du -h "$OUT/libffmpegJNI.so" | cut -f1) ($needed)"
done
