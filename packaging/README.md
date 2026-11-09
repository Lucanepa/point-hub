# Point Hub's channels

Point Hub is distributed from this repository only. Up to desktop 1.1.1 and APK 1.1.0 it also
went out through OpenVolley's channels (get.openvolley.app, OpenVolley's Homebrew tap and
Scoop manifest); since 9 November 2026 it has its own, and OpenVolley carries nothing of it.

Download page: **https://lucanepa.github.io/point-hub/** (GitHub Pages, branch `gh-pages`,
written by `fdroid/publish-fdroid.sh`).

| Channel | For | Where | Updates |
|---|---|---|---|
| The board | the tablet at the board | `deploy-board.sh` puts `android/dist/` on the board; the app fetches `/app/version.json` and installs a newer APK by itself | automatic |
| F-Droid | a new tablet, any Android | Point Hub's own repo `https://lucanepa.github.io/point-hub/fdroid/repo` (`fdroid/`) | F-Droid |
| GitHub releases | Linux `.deb` / `.rpm`, Windows `.msi`, macOS `.dmg` | `desktop-v<version>`, built by `.github/workflows/desktop.yml` | by hand: no updater |
| Scoop | Windows | this repository is the bucket: `bucket/point-hub.json` | `scoop update point-hub` |
| Homebrew | macOS | this repository is the tap: `Casks/point-hub.rb` | `brew upgrade` |
| winget | Windows | `KSCWiedikon.PointHub` in microsoft/winget-pkgs (`winget/`) | `winget upgrade` |
| AUR | Arch | `point-hub-bin` (`aur/`), not published yet: needs the AUR account | — |

```bash
scoop bucket add point-hub https://github.com/Lucanepa/point-hub
scoop install point-hub/point-hub

brew tap lucanepa/point-hub https://github.com/Lucanepa/point-hub
brew install --cask lucanepa/point-hub/point-hub
```

The tap and the bucket read `main`, so a change there is live once merged. Neither needs a
name of its own (`homebrew-…`), only the URL in the first command.

**Not here (yet): APT, Flatpak, pacman.** Those are repositories on a server, and the desktop
installers (150 to 230 MB) are too big for GitHub Pages (100 MB per file). They need a host of
Point Hub's own, for example on the club's domain. OpenVolley's former manifests for them are
in Lucanepa/openvolley's history, commit `577e9afc`: `escoresheet/packaging/flatpak/ch.kscw.PointHub.*`,
`escoresheet/packaging/pacman/`, `escoresheet/deploy/publish-pkgs.sh --point-hub`.

## A desktop release

1. Bump `android/desktop/version.properties`, merge, tag `desktop-v<version>`: CI builds and
   publishes the GitHub release (it becomes "Latest", which Scoop's `checkver` and Homebrew's
   `livecheck` read).
2. Package managers, from a checkout of `main` (downloads the release, about 800 MB; checks the
   `.deb`, the `.msi` and both disk images, then writes every checksum):
   ```bash
   packaging/bump.sh <version>
   packaging/check.sh --urls
   ```
   Commit and merge: Scoop and Homebrew have it then.
3. winget: submit `winget/manifests/k/KSCWiedikon/PointHub/<version>/` to
   microsoft/winget-pkgs as a pull request from a fork (same path there). Only the version being
   submitted is kept here. The first one, 1.1.1, is
   [microsoft/winget-pkgs#455755](https://github.com/microsoft/winget-pkgs/pull/455755).
4. AUR, once it is published: push `aur/point-hub-bin/PKGBUILD` and `.SRCINFO` to
   `ssh://aur@aur.archlinux.org/point-hub-bin.git`.

`bump.sh <version> <pkgrel>` changes only the AUR release (a PKGBUILD fix, same files).
`POINTHUB_RELEASE_DIR=<folder>` reads the release files from that folder instead of
downloading them.

## An Android release

1. `android/build-release.sh --version-name <version>` (commit `android/version.properties`).
2. The board: `./deploy-board.sh` (the tablet updates itself from it).
3. F-Droid and the download page:
   ```bash
   packaging/fdroid/publish-fdroid.sh android/dist/pointhub.apk
   ```
   It checks the APK's signing certificate against `android/signing-cert.sha256`, adds it to the
   repo in `~/.config/point-hub-fdroid` (on lenovoserver), signs the index, and force-pushes the
   site (the repo's `repo/` folder plus `fdroid/index.html`) as the single commit of `gh-pages`.
   The repo keeps the newest three APKs.

**Once:** `packaging/fdroid/publish-fdroid.sh --init` creates the repo and its key. Back up
`~/.config/point-hub-fdroid/config.yml` and `keystore.p12` in the club's Vaultwarden ("Point Hub
F-Droid repo key"): without them the repo can only be replaced under a new fingerprint. GitHub
Pages: Settings > Pages > Deploy from a branch, `gh-pages`, `/`.

The F-Droid listing (name, summary, description) is `fdroid/ch.kscw.pointhub.yml`, the icon
`android/desktop/icons/point-hub.png`.

## Checks

`packaging/check.sh` (offline): every file parses, the four package managers name the same
version, and each points at that version's release asset with a real checksum. `--urls` also
asks GitHub that the files are there.
