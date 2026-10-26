cask "torflix" do
  arch arm: "arm64", intel: "x64"

  version "0.3.0"
  sha256 arm:   "412057ed3151ac3237f1b9293957705500a3d46c677eaae4bb4ca36865e636bc",
         intel: "7590792f9f1d7916e84249a9f3124f219eaaf7ddca49508c199b043b545dbebc"

  url "https://github.com/gary23w/torflix/releases/download/v#{version}/Torflix-#{version}-mac-#{arch}.dmg"
  name "Torflix"
  desc "Torrent video streaming and downloads with a built-in player"
  homepage "https://github.com/gary23w/torflix"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Torflix.app"
end
