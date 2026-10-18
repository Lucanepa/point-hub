# Point Hub: desktop app

The same native Game tab, header and tabs as the tablet app (`../shared`, Compose Multiplatform),
for Linux, Windows and macOS. The console's other tabs (Link, History, Diagnostics, Settings) are
the board's own pages, embedded under the native header through Chromium (JCEF, from JetBrains
Runtime). They are shown in off-screen mode: Chromium hands over each frame as pixels, Compose draws
it, and mouse and keys go back as AWT events. There is no native child window, so the header and
the dialogs always draw on top of the page.

## How it finds the board

The address typed in Settings first, then the board's https name, then `http://172.24.1.1:8890`
(its Wi-Fi) and `http://192.168.5.1:8890` (the cable). All are asked at once; the first in that
order that answers `GET /api/status` wins. When the board goes quiet it looks again, and moves to
another address if that is where the board now answers.

## The bridge

The console asks the app synchronously (`window.PointHubApp`, android/BRIDGE.md). Chromium only
calls into the app asynchronously, so the desktop fetches the console's HTML itself and puts a
small `window.PointHubApp` in front of its scripts. That object answers from values handed over
with the page (the scorer PIN, whether to embed, the app info, the backups list), and the app keeps
them current. Everything else goes through `cefQuery`, and only from the board's own origin.

Backups and the schedule copy are kept in the data directory (`~/.local/share/point-hub` on Linux,
`%LOCALAPPDATA%\Point Hub` on Windows, `~/Library/Application Support/Point Hub` on macOS). Settings
▸ "Export backups" in the console writes them to a zip.

## Build

The app compiles and runs on **JetBrains Runtime with JCEF**, the SDK build (`jbrsdk_jcef-21…`).
Point `POINTHUB_JBR` at it:

```bash
curl -fLO https://cache-redirector.jetbrains.com/intellij-jbr/jbrsdk_jcef-21.0.11-linux-x64-b1163.116.tar.gz
tar xzf jbrsdk_jcef-21.0.11-linux-x64-b1163.116.tar.gz
export POINTHUB_JBR=$PWD/jbrsdk_jcef-21.0.11-linux-x64-b1163.116

cd android
./gradlew :desktop:run                  # run it
./gradlew :desktop:packageDeb           # build/compose/binaries/main/deb/point-hub_<version>_amd64.deb
./gradlew :desktop:packageMsi           # on Windows
./gradlew :desktop:packageDmg           # on macOS
```

- **Version:** `desktop/version.properties`.
- **Runtime image:** jlink makes it from the JBR with the modules listed in `build.gradle.kts`. The build puts
  the executable bit back on Chromium's helpers, and keeps only the en, de, fr and it locales.
- **Size:** about 150 MB per package, most of it Chromium (`libcef` alone is 225 MB unpacked).
- **CI:** `.github/workflows/desktop.yml` builds the packages for every platform.

## Settings

The ⚙ on the search screen, and the console's own "Settings" button inside the app, open the
desktop's settings:
- the board address (empty = find it);
- the Game screen: native, or the whole web console as a fallback.

They are kept in `settings.json` in the config directory (`~/.config/point-hub` on Linux, under
`XDG_CONFIG_HOME`, which Flatpak points into its sandbox).
