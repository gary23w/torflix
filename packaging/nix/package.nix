{ lib, stdenv, fetchurl, appimageTools, autoPatchelfHook, makeWrapper,
  makeDesktopItem, copyDesktopItems, electron_44-bin, ffmpeg, openssl }:
let
  release = builtins.fromJSON (builtins.readFile ./release.json);
  extracted = appimageTools.extract {
    pname = "torflix";
    inherit (release) version;
    src = fetchurl { inherit (release) url hash; };
  };
in stdenv.mkDerivation {
  pname = "torflix";
  inherit (release) version;
  src = extracted;
  nativeBuildInputs = [ autoPatchelfHook makeWrapper copyDesktopItems ];
  buildInputs = [ stdenv.cc.cc.lib openssl ];
  dontBuild = true;
  dontStrip = true;
  passthru.electron = electron_44-bin;

  desktopItems = [ (makeDesktopItem {
    name = "torflix";
    desktopName = "Torflix";
    comment = "Torrent video streaming and downloads";
    exec = "torflix %U";
    icon = "torflix";
    categories = [ "AudioVideo" "Video" "Network" "FileTransfer" ];
    mimeTypes = [ "application/x-bittorrent" "x-scheme-handler/magnet" ];
  }) ];

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/torflix" "$out/bin"
    cp resources/app.asar "$out/share/torflix/"
    cp -r resources/app.asar.unpacked "$out/share/torflix/"
    # This package targets glibc; the alternate musl binary is never selected here.
    rm "$out/share/torflix/app.asar.unpacked/node_modules/utf-8-validate/prebuilds/linux-x64/utf-8-validate.musl.node"
    install -Dm644 .DirIcon "$out/share/icons/hicolor/512x512/apps/torflix.png"
    install -Dm644 ${../../LICENSE-MIT} "$out/share/licenses/torflix/LICENSE-MIT"
    install -Dm644 ${../../LICENSE-APACHE} "$out/share/licenses/torflix/LICENSE-APACHE"
    makeWrapper ${electron_44-bin}/bin/electron "$out/bin/torflix" \
      --add-flags "$out/share/torflix/app.asar" \
      --prefix PATH : ${lib.makeBinPath [ ffmpeg ]}
    runHook postInstall
  '';

  meta = {
    description = "Torrent video streaming and downloads with a built-in player";
    homepage = "https://github.com/gary23w/torflix";
    license = with lib.licenses; [ mit asl20 ];
    mainProgram = "torflix";
    platforms = [ "x86_64-linux" ];
    sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
  };
}
