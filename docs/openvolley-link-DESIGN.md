# Score in OpenVolley, show it on Point Hub — design

Status: **design, nothing built yet** (11.11.2026). Phase 1 is the first thing to build.

The goal: score the match in OpenVolley on a PC, a tablet or a phone, and the Point Hub board
shows it. It must work **with no internet** in the hall.

## What exists today

- **Link mode** (`src/lanSource.js`, `src/relaySubscriber.js`): the board subscribes to an
  OpenVolley **relay** and mirrors the one match it picks. Breaks, result screen and live
  publishing already work for a linked match.
- **The relay has to be on a laptop.** Only the OpenVolley **desktop app** (Tauri; also
  Electron and `frontend/server.js`) runs a relay (HTTP :5173, WS :8080). The board finds the
  laptop on its own networks (`src/relayAddress.js`) or takes Settings ▸ Scorer laptop address.
- **The tablet and phone builds do not run a relay.** The Android app (Capacitor) and the web app
  (openvolley.app) are relay *clients* only. The Android app can point at a local server
  (Options ▸ Server ▸ Change server ▸ Local, any private address); the web app on
  openvolley.app always uses the cloud, and an https page cannot open `ws://` to the board anyway.
- **The cloud** (`wss://backend.openvolley.app`) needs internet on both ends, never carries test
  or Easy matches, and lists a match only with the referee connection on or from the same public
  IP. `src/cloudSource.js` is still a stub.
- **The DIY board** already runs the OpenVolley desktop app on its own screen (pointhub-screen),
  so it has a relay on :5173/:8080 *while that app is open*, and follows its live match by itself.

So today: PC works (offline too), tablet and phone only through the cloud (online only, not
built on the board side).

## The idea: the board is the OpenVolley server

The board runs **OpenVolley's own relay and web app** as a service of its own:
`frontend/server.js` + `lanRelayCore` + the built `dist/` + `ws` (zero native code; Node 22
runs it on the C0270's armhf and on the Pi 5). Same ports as the desktop app, **:5173** (web app
and `/api/*`) and **:8080** (relay).

- Link mode already defaults to `ws://127.0.0.1:8080`: the board follows the match on its own
  relay with nothing to set.
- Every device scores against **one address, the board's**, online or offline.
- A **browser** needs no install: `http://<board>:5173` loads OpenVolley from the board, and the
  page publishes to its own host (`backendConfig.js` rule 4), so it works on an iPhone too.
- Nothing changes in OpenVolley (it stays club-agnostic): the board serves an unchanged release
  build.

## Connection per device

Board addresses: **C0270** = its Wi-Fi `ledbox_C0270` → `172.24.1.1`, or the cable →
`192.168.5.1`. **DIY Point Hub** = the DATA cable → `192.168.5.1` only (no Wi-Fi of its own,
owner decision 22.10.2026).

| Device | How it scores | Connect to the board | Offline |
|---|---|---|---|
| **PC, OpenVolley desktop app** | its own relay (as today) | join `ledbox_C0270` (C0270) or the cable; the board finds the laptop | yes |
| **PC, browser** | OpenVolley from the board | `http://172.24.1.1:5173` / `http://192.168.5.1:5173` | yes |
| **Tablet, Android app** | the board's relay | Options ▸ Server ▸ Change server ▸ Local ▸ board address | yes |
| **Tablet / iPad, browser** | OpenVolley from the board | the address above (QR on the console) | yes |
| **Phone, Android app** | the board's relay | as the tablet | yes |
| **Phone, browser (incl. iPhone)** | OpenVolley from the board | as the tablet; on the DIY board through the DATA cable (the phone sees a USB Ethernet) | yes |
| **Any device on openvolley.app** | the cloud | board needs hall internet + the cloud source (phase 3) | **no** |

Referee and bench tablets connect to the same address (`/referee`, `/bench`), as they do to a
laptop today.

## Traps to handle

- **Two relays on one DIY board.** When the screen runs OpenVolley, the desktop app's own relay
  takes :5173/:8080. The board service steps aside while it runs (`Conflicts=` with the screen's
  OpenVolley, started again on Quit). Only one scorer is ever live, so this is enough; a scorer
  on the cable then talks to the screen's relay.
- **Phone on a Wi-Fi with no internet.** Android may offer "Stay connected?" or send traffic over
  mobile data; private addresses still go over the Wi-Fi. The hall card must say: answer *Yes,
  stay connected*.
- **Plain http.** No service worker (not a secure context), so the page needs the board to load,
  which it always has. OpenVolley's scorer does not need `crypto.subtle`. Matches stay in that
  browser's storage for that address; using the IP every time keeps them in one place.
- **Version.** The board serves the OpenVolley build it was deployed with; the Android app may be
  newer or older. The relay protocol has been stable across releases, but the board's build
  should follow each OpenVolley release (deploy step, below).
- **Firewall.** Open :5173/:8080 on the board's Wi-Fi (C0270 `wlan0`) and cable (`eth0`), never on
  the hall uplink (`wlan1`). The DIY board already opens them on `eth0`.
- **Who can score.** Anyone on the board's Wi-Fi can open the scorer page. That is the same as a
  laptop relay today; OpenVolley's own game and referee PINs guard the match, the scorer PIN
  guards the console.

## Phases

1. **Board hosts OpenVolley** — `pointhub-openvolley.service` (`node server.js`, `PORT=5173`,
   `WS_PORT=8080`), a build step that takes `dist/` + `server.js` + `lanRelayCore` + `ws` from
   an OpenVolley release tag into `/opt/openvolley-web/<version>` (symlink, as `/opt/nodejs`),
   `deploy-board.sh` and `setup-board.sh` install it, firewall ports on `wlan0`. Test: the e2e
   test (`npm run test:e2e`) with the relay on the board, scorer in Chromium at phone and tablet
   size, no network namespace, board follows.
2. **"Score with OpenVolley" on the console** — Link tab card: the board's relay running or not,
   the address and a QR for "app" (server address) and "browser" (URL); the panel's idle QR can
   point there too. Hall card and hall guide: one line per device.
3. **Cloud source** (optional) — `CloudSource` subscribes to `wss://backend.openvolley.app` by seed
   key, for a scorer on openvolley.app with internet. Only if wanted: it is online only and does
   not carry Easy matches.
