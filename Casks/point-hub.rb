# Homebrew cask of Point Hub. This repository is the tap:
#   brew tap lucanepa/point-hub https://github.com/Lucanepa/point-hub
#   brew install --cask lucanepa/point-hub/point-hub
# packaging/bump.sh rewrites the version, both checksums and the app name.
cask "point-hub" do
  arch arm: "arm64", intel: "x64"

  version "1.1.1"
  sha256 arm:   "d17e84f2a11b9356bc7ce1c3b984ddfca299067b2f983f7b8321cd025bb6835a",
         intel: "b1be16be3a77c350547d068c44e39a2531739d9b09ecef38e20e538bb14a2752"

  url "https://github.com/Lucanepa/point-hub/releases/download/desktop-v#{version}/Point-Hub-#{version}-macos-#{arch}.dmg",
      verified: "github.com/Lucanepa/point-hub/"
  name "Point Hub"
  desc "Console of the LedBox scoreboard"
  homepage "https://github.com/Lucanepa/point-hub"

  # Its desktop releases are GitHub's "Latest" of that repo, tagged desktop-v<version>.
  livecheck do
    url :url
    regex(/^desktop-v?(\d+(?:\.\d+)+)$/i)
    strategy :github_latest
  end

  # Chromium in its runtime needs macOS 12; the bundle says so too (LSMinimumSystemVersion).
  depends_on macos: ">= :monterey"

  # No auto_updates: Point Hub has no updater, `brew upgrade` brings each version.
  app "point-hub.app"

  # The settings and the game backups (~/Library/Application Support/Point Hub) stay.
  zap trash: [
    "~/Library/Caches/ch.kscw.pointhub",
    "~/Library/Preferences/ch.kscw.pointhub.plist",
    "~/Library/Saved Application State/ch.kscw.pointhub.savedState",
  ]

  caveats <<~EOS
    Point Hub is not notarized by Apple, so macOS blocks its first start.
    Open it once, then System Settings > Privacy & Security > Open Anyway.
    Or in Terminal:
      xattr -dr com.apple.quarantine "/Applications/point-hub.app"
  EOS
end
