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
  IP. `src/cloudSource.js` is still a stub; the board links cloud matches with `LanSource` instead (phase 3).
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
| **Any device on openvolley.app** | the cloud | board needs hall internet; Link tab ▸ OpenVolley cloud (phase 3) | **no** |
| **Tablet on `ledbox_C0270`, Android app, online** | the cloud | Settings ▸ OpenVolley online ON; the board follows by itself | **no** |

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

## Following a cloud match (17.11.2026)

The C0270 followed its first real match through the cloud (`relayAddress` =
`wss://backend.openvolley.app`, the Android app on the board's Wi-Fi with OpenVolley's hosts let
through). What that showed, and what the board does about it now (README, "What a linked match
shows"):

- The scorer sat behind the board and the panel's sides were the wrong way round: OpenVolley's
  sides are the scorer's. Settings ▸ Scorer sits behind the board (`orientation: 'behind'`, the
  default) now mirrors a linked match, live; off (`'front'`, the scorer faces the board) passes the
  sides through.
- A viewer without the match PIN gets no substitutions from the cloud (`LIVE_STATE_PRIVATE_COLUMNS`):
  the board counts them from the public events, takes the PIN when offered, and prefers OpenVolley's
  public `subs_count_a/_b` (openvolley#241) once a release sends them.
- The live state has no `set_results`: the board records the sets itself, and takes OpenVolley's
  (openvolley#241: `[{ set, home, away, a, b }]`) when they come.
- A bridge restart in a set break restarted the 3-minute interval: a break already running when the
  link begins now resumes from the match's own start, or stays off.
- livePush timed out about once per 20 minutes on the school Wi-Fi: 8 s budget, the first failure
  of a round is info, the retry carries the latest state.
- The board did not know the match's game number: it now comes from the match summary.
- (20.11.2026, a hand-scored game) the panel was right and kscw.ch/live showed the teams mirrored.
  livePush's board row is now the court as the SCORER sees it, for every source: the state's
  `side_a` / `serving_team` are panel sides (a linked state arrives after the panel mirror), so
  behind the board they are turned back — for a linked match that is OpenVolley's own sides, so the
  tablet, a console game and /live agree. Once final, home is on A (the fixture, else the view's
  `home_ab`). See the livePush.js header.

## Follow by scoreboard code (22.11.2026)

OpenVolley's scorer can now show a short read-only **scoreboard code** (Match ▸ Show on a
scoreboard, openvolley#317; spec: openvolley `escoresheet/docs/scoreboard-code-spec.md`, contract for
boards: `docs/scoreboard-feed.md`). A board that knows the code finds the match on the relay the
scorer uses and gets the PIN-free public live state, whatever network either side is on. For the
C0270 that removes the cloud link's catch: the board no longer needs the tablet on its Wi-Fi
(OpenVolley online) to see a cloud match, and nothing depends on `cloudListsMatch` showing the match
to the board's public address.

- **Console**: Link tab ▸ *Follow by scoreboard code*: the code (typed, or the board link of the
  scorer's QR code pasted: `…/board#CODE`), the relay (OpenVolley cloud by default; the board's own
  OpenVolley where it runs one; a scorer laptop), **Link**, and a status line (following, until when /
  not found right now, trying again in N s / too many tries / ended / not found / an older OpenVolley).
  Behind the scorer PIN.
- **API**: `POST /api/link { source: 'code', code, relay? }`. The code is normalised as the relays do
  (8 symbols of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, case, spaces and dashes ignored, `followCode.js`).
  First `POST /api/display/lookup { code }` on the relay's HTTP side, so a wrong, ended or rate-limited
  code is answered (404 / 410 / 429) before the panel is touched; a relay whose HTTP side does not
  answer as one leaves it to the WebSocket.
- **Link**: the same `LanSource` → `LinkedView` → `RelaySubscriber` as every link (mirror, sub count,
  set history, SATZBALL / WECHSEL, result screen, livePush unchanged). `RelaySubscriber` sends
  `subscribe-match { code, device: 'display', settingsUrl? }` (no matchId, no PIN), learns the room
  from `display-code { ok, matchId, endsAt }` and takes only that room's messages from then on.
  - `ended`: final, the subscriber stops (no reconnect), the board unlinks: the result stays if it is
    up, else the clock — the rule of a deleted match.
  - `not-found` for a code this board never followed: final (a typo, or the scorer is on another
    relay). For one it followed before, or restored after a restart: the relay or the scorer is
    reconnecting, so it is asked again after 15, 30, then every 60 s on the open socket, and given up
    after 30 min (`CODE_RETRY_MS`, `CODE_GIVE_UP_MS`).
  - `rate-limited`: nothing is sent before `retryAfter` (5 s … 1 h), on this socket or a new one.
  - An older relay answers `Match ID required`: final, "this OpenVolley does not know codes yet".
  - A reconnect sends the code again (a restarted relay learns it back from the scorer).
- **Kept**: `data/follow-code.json` (0600, atomic) while the code is followed, so a bridge restart
  follows it again by itself (before an interrupted hand-scored game: it was what the board showed);
  cleared on any other source (a link by match, Stop following, the console) and when the code ends.
  Never logged: log lines carry `ref=` + 8 hex of sha256("d:" + code), the ref OpenVolley's relays log.
  `/api/status.followCode` never carries the code.
- Not with a match PIN (`POST /api/link/pin` → 409): a code gives the public state only, and the
  relays ignore a PIN next to one. Substitutions come from `subs_count_*` (or the board's count).
- The board's own follows leave it alone: `followCloudScorer` never takes over a code link,
  `followLocalScorer` only once its match has ended.
- Tests: `test/follow-code-selftest.mjs` (in `npm test`); `test/e2e-live.mjs` [9] against the real
  relays of an OpenVolley checkout that has scoreboard codes (`OPENVOLLEY_DIR=…`).
- Not done: scanning the QR code with the console's camera (the console is plain http on the board,
  so the browser gives it no camera); a scanner app's result or the link itself can be pasted.

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
3. **Cloud** (built 17.11.2026, not yet on the board) — no `CloudSource`: the cloud speaks the relay
   protocol, so a cloud match is linked with the same `LanSource`, on `wss://backend.openvolley.app`.
   - **Link tab**: `GET /api/matches` also asks the cloud's `/api/match/list` and lists its matches
     under the laptop's ("OpenVolley cloud"): the hall's own first — listed with the referee
     connection off (the cloud shows those only to the scorer's own public address) or with a game
     number from this board's schedule — then up to 30 others. Only the board's sport, never a test
     or a finished match. One tap: `POST /api/link { source: 'cloud' }`.
   - **Settings ▸ OpenVolley online** (owner switch, scorer PIN, OFF by default): a tablet on
     `ledbox_C0270` reaches `*.openvolley.app` on 443 through the board's uplink and nothing else
     (`provisioning/ledbox-ov-online.sh`, installed by `setup-ov-online.sh`), so the Android app
     scores online; the tablet shares the board's public address, so the board sees its match.
   - With the switch ON the board links the one live cloud match from this hall by itself, every
     10 s (`followCloudScorer`, the rules of `followLocalScorer`): never over a hand-scored game in
     play or a countdown, never over a laptop's or the board's own match, and a cloud match still
     going stays linked until it has ended.
   - Online only, and no Easy matches (the cloud does not carry them).
