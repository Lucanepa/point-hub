# Point Hub: Android tablet app

This app is the board's dedicated control screen for a Samsung Galaxy Tab A (Android 13–15). It is a
fullscreen, landscape kiosk that shows the LedBox console served by the board.

| | |
|---|---|
| Package | `ch.kscw.pointhub` |
| Label | "Point Hub" |
| SDK | minSdk 26, targetSdk 35, compileSdk 35 |
| Release signing certificate (SHA-256) | `6d:66:f6:14:94:fe:aa:02:c3:1f:03:0b:5a:0a:af:74:9a:c2:4c:be:85:26:84:f7:5e:b5:8b:8d:92:e4:8c:22` (also in `signing-cert.sha256`) |

## What the app does

- **Loads the console from the board.** It tries these origins in order:
  - `https://ledbox-c0270.noodlefish-pence.ts.net:8891`
  - `http://172.24.1.1:8890` (the board's AP)
  - `http://192.168.5.1:8890` (cable)

  It probes `GET /api/status` on each and uses the highest-priority one that answers. Console
  updates need nothing from the app. The two plain-http addresses are only tried over a network
  where the board itself answered at 172.24.1.1 / 192.168.5.1 (its Wi-Fi or cable). On any other
  network (hall Wi-Fi, mobile data) only the https name is tried, so a device on a foreign network
  cannot pose as the board over cleartext.
- **Uses the board's Wi-Fi even without internet.** The AP `ledbox_C0270` has no internet, and the
  tablet may also have mobile data. The app finds the board LAN by reaching 172.24.1.1 through each
  Wi-Fi network (or 192.168.5.1 through Ethernet). It then calls `bindProcessToNetwork()`, so all its
  traffic, WebView included, goes to the board and never to mobile data. If no board LAN is found,
  it stays on the default network. That is the Tailscale case (hall Wi-Fi plus the Tailscale app),
  where binding would bypass the VPN. While bound it also holds a plain Wi-Fi (or Ethernet)
  network request, which marks the no-internet AP as "needed" so Android does not drop it in
  favour of mobile data. The binding is only released when that network is actually lost.
- **Keeps a live match up.** If the board link drops mid-match, the console stays on screen and
  usable (it records scores without the board); a small "connection lost" note appears at the top.
  When the link returns on the same address nothing reloads. The full offline screen only appears
  when no console page is loaded.
- **Covers failures with its own screen.** When nothing answers, a native screen says "Looking for
  the scoreboard… Is it switched on? Is this tablet on ledbox_C0270?". It retries every 3 s, has
  **Retry** and **Connect to scoreboard Wi-Fi** buttons, and shows the last known match from the
  newest backup, read-only. A browser error page never shows. While the app is pinned,
  **Connect to scoreboard Wi-Fi** asks for the admin PIN first: Android's "Connect to device"
  dialog opens outside the pinned app, so the app has to unpin while it shows.
- **Kiosk.** It stays fullscreen immersive, keeps the screen on, and Back never leaves the app. It
  uses screen pinning, or a real lock-task kiosk when the app is device owner. Without device
  owner the "Pin app?" prompt is shown once per app start; if it is declined the app does not ask
  again (and never mid-match) until the next start or admin menu → **Resume kiosk**. The
  save-file sheet (backup export) and the permission dialog open inside the pinned app. Only
  admin-menu actions (Android settings, app info, home screen, installing an update, Wi-Fi setup)
  unpin the tablet, and it pins again when you come back.
- **Hidden admin menu.** Tap the top-left corner 5 times within 3 s, then enter the app's
  **admin PIN**. The default is `2026`; change it at first run or in the menu. It is not the board's
  scorer PIN. The menu covers:
  - Wi-Fi setup, board URL override, changing the PIN
  - exporting backups
  - checking for and installing app updates
  - exit/resume kiosk, pinning on/off, home screen on/off
  - Android settings, exit app, about
- **Updates itself from the board.** See [Self-update](#self-update).
- **JS bridge.** `window.PointHubApp` lets the console save backups and the schedule on the tablet.
  See [BRIDGE.md](BRIDGE.md).

## Build

Requirements, all present on the build machine:
- JDK 17+ (JDK 21 at `/usr/bin/java`)
- Android SDK at `/home/lucanepa/Android/Sdk` with platform 35 and build-tools 35.0.0

The Gradle wrapper (8.14.3), AGP 8.11.0 and Kotlin 2.0.21 are downloaded or reused from
`~/.gradle`.

```bash
cd android
./build-release.sh --notes "What changed for volunteers"
# → dist/pointhub.apk + dist/version.json
```

The script does the following:
1. Refuses to run without the release key. No unsigned APK is ever produced.
2. Bumps `version.properties`:
   - the new versionCode is `max(VERSION_CODE, RELEASED_CODE, ~/.config/pointhub-android/last-version-code, dist/version.json) + 1`,
     so it is always higher than every earlier release;
   - `RELEASED_CODE` is tracked in git, so a fresh clone on another machine continues correctly;
   - it refuses to run when no earlier release is recorded anywhere. The very first release is
     built with `./build-release.sh --first`, which keeps `VERSION_CODE` as it is and is refused
     once `RELEASED_CODE` is set;
   - the patch number goes up automatically, or you set it with `--version-name 1.2.0`.
3. Runs `./gradlew clean lintRelease testReleaseUnitTest assembleRelease`.
4. Checks the APK:
   - `apksigner verify`, and the signer must equal `signing-cert.sha256`;
   - `aapt2 dump badging`: package, versionCode, minSdk 26, targetSdk 35, label "Point Hub".
5. Writes `dist/version.json`: `{versionCode, versionName, sha256, url:"/app/pointhub.apk", notes, size}`.

**Commit `version.properties` after every release.** Its `RELEASED_CODE` is what keeps the next
build, on any machine, above the versionCode installed on the tablets. A build with an equal or
lower versionCode is never installed by the tablets: they would silently stay on the old app.

Development builds:

```bash
./gradlew test lint          # JVM unit tests + lint
./gradlew assembleDebug      # debug build, same package id, debug-signed
```

A debug build has the same package id but a different signature, so it cannot be installed over a
release build or the other way round. Run `adb uninstall ch.kscw.pointhub` first; that wipes the
tablet's backups, so export them before. WebView remote debugging (`chrome://inspect`) works only in
debug builds.

To regenerate the launcher icon from `web/favicon.svg` (the shapes are copied into
`tools/icon-*.html`), run `tools/render-icons.sh`. It needs headless Chrome. The PNGs are committed.

## The release key (back it up!)

There is **one** release key for every build, forever:

| File | Contents |
|---|---|
| `/home/lucanepa/.config/pointhub-android/release.jks` | PKCS12, alias `pointhub`, RSA 4096, valid 100 years. Mode 600. |
| `/home/lucanepa/.config/pointhub-android/keystore.properties` | Store and key password (random, 40 chars), path, alias. Mode 600. |
| `/home/lucanepa/.config/pointhub-android/last-version-code` | The last versionCode this machine built (a second record next to `RELEASED_CODE`). |

Gradle finds it in this order:
1. `android/keystore.properties` (gitignored). It holds either the four keys or a
   `propertiesFile=` pointer; see `keystore.properties.example`.
2. `$POINTHUB_KEYSTORE_PROPERTIES`
3. `~/.config/pointhub-android/keystore.properties`

**If the key is lost, installed tablets can never be updated.** Android refuses an update signed with
a different key (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). Every tablet would then have to uninstall and
reinstall, which deletes its app-private backups.

Back it up now:
1. Put `release.jks`, `keystore.properties` and `last-version-code` as attachments in the password
   manager (Vaultwarden item **"Point Hub Android release key"**).
2. Put a second copy on one offline medium (a USB stick in the club's key box).
3. Check a backup copy still opens:
   ```bash
   keytool -list -v -keystore release.jks -storepass "$(grep storePassword keystore.properties | cut -d= -f2)" | grep SHA256
   # must print 6D:66:F6:14:94:FE:AA:02:C3:1F:03:0B:5A:0A:AF:74:9A:C2:4C:BE:85:26:84:F7:5E:B5:8B:8D:92:E4:8C:22
   ```

Never generate a new key "to fix" a signing problem. Restore the backup instead.

## First install on a tablet

### A. From the board (no computer)

1. Connect the tablet to Wi-Fi `ledbox_C0270` (the password is on the hall card).
2. In Chrome, open `http://172.24.1.1:8890/app` and tap **Download Point Hub** (the page shows the
   version it offers). Chrome asks to allow "Install unknown apps" for Chrome once. Allow it, then
   install. (A plain browser console also links there from Settings → "Get the tablet app".)
3. Open **Point Hub**. First-run setup asks for:
   - Wi-Fi name (default `ledbox_C0270`)
   - Wi-Fi password
   - admin PIN (prefilled `2026`)

   Then allow **Nearby devices** (used only to join the scoreboard Wi-Fi, never for location) and
   confirm Android's **"Save this network?"** sheet.
4. Android asks to **pin** the app. Confirm.

### B. With adb (USB debugging on)

```bash
adb install -r -i ch.kscw.pointhub dist/pointhub.apk   # try this first (see below)
adb install -r dist/pointhub.apk                        # if Android rejects -i
```

`-i ch.kscw.pointhub` makes the app its own *installer of record*, which makes even the first
self-update silent (Android 12+). If Android rejects it, the plain install works. The first update
then asks for one confirmation, and the ones after it are silent.

### Tablet checklist (Samsung One UI)

- [ ] **Keep the board Wi-Fi.** When Android says "No internet – stay connected?" or "Connected
      without internet", tap **Yes / Don't ask again for this network**.
- [ ] **Stop Samsung dropping it.** Go to *Settings → Connections → Wi-Fi → ⋮ → Intelligent Wi-Fi*
      and turn **off**:
  - "Switch to mobile data" (older One UI: "Auto switch to mobile data")
  - "Turn Wi-Fi on/off automatically"
  - "Prioritise real-time data", if it causes drops
- [ ] **Private DNS: Automatic or Off.** A strict hostname breaks name resolution on the AP. The IP
      fallbacks still work.
- [ ] **Clock.** *Settings → General management → Date and time → Automatic*. Check that the time is
      right. A wrong clock breaks https, and the app then falls back to `http://172.24.1.1:8890`.
- [ ] **App pinning.** *Settings → Security and privacy → More security settings → Pin app*: **on**.
      **"Ask for PIN before unpinning"** is optional. With it on, Android locks the tablet every time
      the app unpins itself for an admin action (Android settings, installing an update, joining the
      Wi-Fi from the offline screen), so the tablet's screen lock is needed afterwards.
- [ ] **Home screen (recommended without device owner).** Use admin menu → **Use as home screen**.
      Home then returns to the console and the tablet starts into it after a reboot. Admin menu →
      **Exit app** still works: it hands Home back to the other launcher for that exit, and the
      next start of Point Hub (tapping its icon, or a reboot as device owner) takes Home back and
      pins again. To stop being the home screen for good, use **Stop being the home screen**.
- [ ] **Battery.** *Settings → Battery → Background usage limits*: Point Hub must not be in "Sleeping
      apps".
- [ ] A Wi-Fi-only Tab A (no SIM) avoids the mobile-data questions entirely.

## Optional: device-owner kiosk (factory-reset tablet)

As device owner the app becomes a proper kiosk:
- lock task that cannot be escaped, status bar and keyguard disabled, power menu only;
- the app is always the home screen;
- it relaunches after a reboot and after a self-update;
- self-updates are always silent;
- the screen stays on while plugged in;
- OS updates install at night (02:00–06:00).

1. **Factory reset the tablet.** During setup, **do not add a Google or Samsung account**:
   `set-device-owner` fails if any account exists. Connect to Wi-Fi only if needed.
2. Enable developer options and USB debugging.
3. Install and make the app device owner:
   ```bash
   adb install -r dist/pointhub.apk
   adb shell dpm set-device-owner ch.kscw.pointhub/.AdminReceiver
   ```
4. Open Point Hub and do the first-run setup.

To undo it, use admin menu → **Remove device owner**; otherwise a factory reset is required. Samsung
Knox does not block `dpm set-device-owner` on the Tab A.

Without device owner:
- pinning can be escaped with Back+Recents, PIN-guarded if you set that up;
- the first update may need one confirmation;
- relaunch after a reboot only happens through the home-screen role.

## Self-update

The app checks the board's `/app/version.json`:
- on start,
- every 6 hours while in front,
- from the admin menu.

If the versionCode is higher than the installed one, a strip appears **below** the console (it
takes its own space and never covers a console control): "App update available (x)" with
**Install…** and **Dismiss**. Only the **Install…** button reacts, and it asks for the admin PIN, so
volunteers cannot trigger it mid-match. Dismiss is remembered for that version. The app then:
1. Downloads the APK from the board, over the bound network.
2. Verifies its sha256, package name, versionCode and **signing certificate**.
3. Installs it with a PackageInstaller session.

The first time, Android asks to allow "Install unknown apps" for Point Hub, and then asks "Update
this app?". From the second update on, updates are silent on Android 12+ (and always silent as
device owner).

After an update the app is restarted as follows:
- **Device owner:** it relaunches itself.
- **Home screen:** Android returns to it.
- **Otherwise:** tap **Open** in the installer dialog, or tap the icon.

## Board side

These are for the server agent and are not part of this directory:

- **Serving the release (done).** `src/controlServer.js` serves, without a PIN:
  - `/app`: the install page (download button, the one-time "Install unknown apps" hint, the
    version);
  - `/app/version.json` as `application/json`;
  - `/app/pointhub.apk` as `application/vnd.android.package-archive`, as an attachment.

  All three are `Cache-Control: no-store`. They are read from `APP_DIST_DIR`, which defaults to
  `<repo>/android/dist`, and give a plain 404 when the file is not there. `deploy-board.sh` copies
  `android/dist/pointhub.apk` and `version.json` to the board when they exist.
- **Discovery endpoint.** `GET /api/status` must stay a 200 with a JSON object body, without
  redirects. The app uses it to find the board.
- **Captive-portal checks.** Today `src/controlServer.js` answers connectivity checks
  (`/generate_204` → 204). On the AP that can make Android report *partial connectivity* ("Limited
  connectivity"), because its HTTPS check still fails. The app does not depend on either behaviour.
  A clean "no internet" (dnsmasq returning NXDOMAIN for `connectivitycheck.gstatic.com` and
  similar) gives fewer prompts. Decide this with the board's own captive-portal needs in mind.

## Manual on-device test checklist

There is no emulator on the build machine, so the JVM unit tests cover the pure logic and the
following needs a real tablet:

- [ ] First run: setup form, Nearby-devices prompt, "Save this network?" sheet, pinning prompt.
- [ ] Board off: the offline screen appears, retries every 3 s, and shows the last match.
      Switching the board on loads the console by itself.
- [ ] Mid-match, power-cycle the board: the console stays usable with the "connection lost" note,
      and comes back without a reload (on a Wi-Fi-only tablet too).
- [ ] Pinned: console `exportBackups()` opens the save sheet without unpinning; the offline
      screen's Wi-Fi button asks for the admin PIN.
- [ ] Home screen on: admin menu → Exit app lands on the Samsung launcher; tapping Point Hub
      restores home + pinning.
- [ ] With mobile data on and the board AP connected, the console loads (the process is bound to Wi-Fi).
- [ ] Wrong tablet date: https fails with the "clock" hint, and the console loads from
      `http://172.24.1.1:8890`.
- [ ] Cable (USB-C Ethernet) with Wi-Fi off: the console loads from `http://192.168.5.1:8890`.
- [ ] 5 taps top-left → PIN → admin menu. Wrong PINs lock out after 5 tries.
- [ ] Console: `PointHubApp.saveBackup`, then `exportBackups()` → zip in Downloads → `export` event.
- [ ] Board serving a higher `version.json`: banner → PIN → install → the app comes back.
- [ ] Back button: never leaves the app.

## Layout

```
build-release.sh        release build → dist/
version.properties      VERSION_CODE / VERSION_NAME (tracked, bumped by the script)
signing-cert.sha256     expected release signer (public)
keystore.properties.example
BRIDGE.md               the JS contract for the console
lint.xml                lint policy (only OldTargetApi / SetTextI18n / version nags suppressed)
tools/render-icons.sh   icon layers from the favicon via headless Chrome
app/src/main/java/ch/kscw/pointhub/
  MainActivity          kiosk host: WebView, offline overlay, banner, admin gesture
  SetupActivity         first run / Wi-Fi setup
  AdminActivity         admin menu
  AdminReceiver         device-admin receiver (for device owner)
  web/                  WebView config, JS bridge, origin allow-list (pure)
  net/                  board discovery: endpoints + prober (pure), network binding, HTTP probe
  store/                backups + rotation (pure), schedule, admin PIN (pure), Keystore secret, prefs
  update/               version.json model (pure), sha256 (pure), download + install
  kiosk/                lock task / home / boot, 5-tap detector (pure)
app/src/test/…          JVM unit tests for everything marked pure
```
