# Score in OpenVolley, show it on Point Hub — design

Status: **phase 1 built** (11.11.2026, not yet on the board). For the C0270; the DIY board already runs
OpenVolley on its own screen. How to install it: README, "OpenVolley on the board (C0270)".

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
- **The DIY board** already runs the OpenVolley desktop app on its own touchscreen
  (pointhub-screen) and follows its live match by itself. That is how the DIY board is used with
  OpenVolley (owner 11.11.2026): **nothing in this design is needed there.**

So today: the DIY board and a PC work (offline too); on the **C0270**, a tablet or phone reaches
the board only through the cloud (online only, not built on the board side). This design is
for the C0270.

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

**C0270** addresses: its Wi-Fi `ledbox_C0270` → `172.24.1.1`, or the cable → `192.168.5.1`.
The **DIY Point Hub** is scored on its own touchscreen, so it is not in this table.

| Device | How it scores | Connect to the board | Offline |
|---|---|---|---|
| **PC, OpenVolley desktop app** | its own relay (as today) | join `ledbox_C0270` or the cable; the board finds the laptop | yes |
| **PC, browser** | OpenVolley from the board | `http://172.24.1.1:5173` / `http://192.168.5.1:5173` | yes |
| **Tablet, Android app** | the board's relay | Options ▸ Server ▸ Change server ▸ Local ▸ board address | yes |
| **Tablet / iPad, browser** | OpenVolley from the board | the address above (QR on the console) | yes |
| **Phone, Android app** | the board's relay | as the tablet | yes |
| **Phone, browser (incl. iPhone)** | OpenVolley from the board | as the tablet | yes |
| **Any device on openvolley.app** | the cloud | board needs hall internet + the cloud source (phase 3) | **no** |

Referee and bench tablets connect to the same address (`/referee`, `/bench`), as they do to a
laptop today.

## Traps to handle

- **Phone on a Wi-Fi with no internet.** Android may offer "Stay connected?" or send traffic over
  mobile data; private addresses still go over the Wi-Fi. The hall card must say: answer *Yes,
  stay connected*.
- **Plain http.** No service worker (not a secure context), so the page needs the board to load,
  which it always has. OpenVolley's scorer does not need `crypto.subtle`. Matches stay in that
  browser's storage for that address; using the IP every time keeps them in one place.
- **Version.** The board serves the OpenVolley build it was deployed with; the Android app may be
  newer or older. The relay protocol has been stable across releases, but the board's build
  should follow each OpenVolley release (deploy step, below).
- **Firewall.** Open :5173/:8080 on the board's Wi-Fi (`wlan0`) and cable (`eth0`), never on
  the hall uplink (`wlan1`).
- **Not on the DIY board.** `setup-board.sh` does not install the service: the screen's
  OpenVolley already owns :5173/:8080 there.
- **Who can score.** Anyone on the board's Wi-Fi can open the scorer page. That is the same as a
  laptop relay today; OpenVolley's own game and referee PINs guard the match, the scorer PIN
  guards the console.

## Easy matches do not reach the board yet

OpenVolley 3.0.20 sends an Easy match to a relay only on a Point Hub board's own screen
(`relayMatchKey`: `easy` and not `window.__OV_POINTHUB_BOARD__` → no key). A phone or tablet
scoring an Easy match against the C0270 therefore publishes nothing, and the board shows
nothing (seen in Chromium, 11.11.2026). Test matches and official matches work.

Setting that flag from the board is no fix: it also blocks pinch zoom and the small-screen gate,
which phones need. The fix belongs in OpenVolley: let an Easy match publish to a **local** relay
(`isLocalRelayUrl`, which already keeps test matches off the cloud), whoever serves the page.
Not done; it is the owner's call.

## Phases

1. **Board hosts OpenVolley** (built) —
   - `tools/build-openvolley-web.sh <version>`: `git archive` of the release tag (no `.env`, no
     `VITE_*`, as desktop.yml), `npm ci` + `vite build`, then `dist/` + `server.js` +
     `lanRelayCore` + the two `.cjs` cores + `ws` (3.8 MB for 3.0.20) and a smoke test.
   - `deploy-board.sh` ships the newest bundle to `/home/pi/openvolley-web/<version>`, flips
     `current`, keeps 3, restarts the service where it is set up.
   - `provisioning/pointhub-openvolley.service` and `setup-openvolley-web.sh` (`--check`,
     `--apply`, `--rollback`): service, `WLAN0_EXTRA_PORTS` / `ETH0_EXTRA_PORTS` = 5173 8080 in
     `/etc/default/ledbox-firewall` (applied through `install-firewall.sh` and its auto-rollback),
     `BOARD_OPENVOLLEY=1` in the bridge's `.env`. Refuses a Point Hub board.
   - `BOARD_OPENVOLLEY=1`: the C0270 follows the one live match on `ws://127.0.0.1:8080` by
     itself (the Point Hub board's `followLocalScorer`, now also without hardware).
   - Tests: `test/point-hub-selftest.mjs` [7b]; `E2E_RELAYS=board` in `test/e2e-live.mjs`, passed
     24/24 against the 3.0.20 bundle in a network namespace with no internet. In Chromium, no
     internet: a test match scored at 390 × 844 and at 1280 × 800 from `:5173` was on the board
     about 1 s later (mode lan, 3:1); an Easy match was not (above).
2. **"Score with the OpenVolley eScoresheet" on the console** (built) — Link tab card, only where
   `/api/status.openvolley` is set (`BOARD_OPENVOLLEY=1`): whether the board's OpenVolley answers
   and how many matches are live (checked every 3 s with the follow), the browser address (the
   cable's when the console is on the cable, else the AP's) and the Android app's server path,
   German and Swiss German. Still open: a QR code (the console has no QR encoder; the panel's
   QR is the firmware's image), and a line on the hall card and guide.
3. **Cloud source** (optional) — `CloudSource` subscribes to `wss://backend.openvolley.app` by seed
   key, for a scorer on openvolley.app with internet. Only if wanted: it is online only and does
   not carry Easy matches.
