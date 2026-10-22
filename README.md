# @openvolley/ledbox-bridge

Mirrors an OpenVolley live match onto a **Tech4Sport LedBox** LED scoreboard.

```
 eScoresheet (Scoreboard)                 LedBox bridge (this service)            Tech4Sport LedBox
        │  computes liveState                       │                                    │
        └── live-state-update (WS) ─▶  LAN relay ──▶  RelaySubscriber                     │
                                                     │  data.liveState                    │
                                                     ▼                                    │
                                            volleyballMapper ── SetSections ──▶ LedboxClient ──gzip/TCP:8889──▶ 📟
```

Small Node service, **no production dependencies** (uses Node 22's built-in global
`WebSocket` for the relay client and `node:net` for the LedBox). It subscribes to the
LAN relay, maps the live match state onto the LedBox `volleyball_matchscore` layout,
and pushes it over TCP with the documented gzip/JSON protocol.

### Runtime on the board

The board's own distro Node is far too old, so the runtime is a tarball install kept
outside the package manager:

    /opt/nodejs -> /opt/nodejs-22.23.2      # symlink; the previous version stays on disk
    /usr/local/bin/node -> /opt/nodejs/bin/node

Upgrading or rolling back is one flip of that symlink plus `systemctl restart
ledbox-bridge`, which is why the unit points at `/opt/nodejs/bin/node` rather than at a
versioned path or at `/usr/bin/node`.

**The board is armhf.** Its kernel is `aarch64` but the userland is 32-bit ARM, so it
needs the `linux-armv7l` tarball — an arm64 build unpacks perfectly and then refuses to
execute, which is a confusing way to find out.

**Node 22 is the last version this board can run.** There is no `linux-armv7l` build of
Node 24 at all; 32-bit ARM was dropped. Node 22 is supported until **2027-04-30**, and
getting past that needs a 64-bit userland on the board, not a newer tarball. Zero
production dependencies is what makes any of this cheap: there is nothing to rebuild
against a new runtime, so an upgrade is a download, a checksum and a symlink.

## Fields shown
points · team short names (in team colour) · sets won · timeouts (**T**) · substitutions (**S**) · serve indicator

## Configure
Copy `.env.example` → `.env`. Every var is optional for the appliance — an empty `.env`
boots a working board on the defaults below (`src/config.js` is the source of truth).

| Var | Default | Notes |
|---|---|---|
| `LEDBOX_HOST` | `172.24.1.1,192.168.5.1` | Comma-separated, tried in turn: the board's own AP, then the bench cable. Pinning ONE address loses the failover — leave it unset unless the board lives elsewhere. |
| `LEDBOX_PORT` | `8889` | |
| `CONTROL_PORT` | `8890` | The console. The QR on the panel and the hall guide point here. |
| `RELAY_URL` / `RELAY_HTTP_URL` | `ws://127.0.0.1:8080` / derived | OpenVolley relay for **Link** mode — only a fallback on the appliance: **Settings ▸ Scorer laptop address** wins (below). The match list (`/api/match/list`) is tried at the relay's own origin first (the standalone `backend/server.js` and the cloud serve HTTP and WS on one port), then on `:5173` of the same host (the desktop app, `frontend/server.js`). Set `RELAY_HTTP_URL` only to pin one URL. |
| `RELAY_DISCOVERY` | `own` | When the configured address does not answer, look for the scorer laptop: one `GET :8080/api/server/status` per address of the networks the board **runs** (its own address ends in `.1` — its Wi-Fi `172.24.1.x` and the bench cable `192.168.5.x`), then `:5173/api/server/status` where 8080 is WS-only, at most 6 s, only on a match-list refresh. Finds both relay families: the standalone `backend/server.js` (`status: 'online'` on 8080) and the desktop app — Tauri, Electron, `frontend/server.js` (`running: true` on 5173). `all` = every private /24 the board is on (a hall network it is a guest on included); `0` = off. A laptop the search found is used for a link only when the operator links a match it listed (each listed match names its laptop, and `POST /api/link` must name a relay the board knows); the Link tab warns when the saved address was silent and another laptop is listing. |
| `TLS_CERT`, `TLS_KEY`, `HTTPS_PORT` | empty, empty, `8891` | Both paths set = an HTTPS listener alongside HTTP (wake lock, installable app). Written by `provisioning/setup-console-tls.sh`. |
| `DIRECTUS_URL`, `LIVE_PUBLISH_TOKEN` | empty | Live publishing to wiedisync, below. The same token lets the board fetch the **match sheet** of the game on it (Link tab ▸ This game: Game info + KSCW roster, for the scorer to read off into the eScoresheet) — only with live scoring on, only behind the scorer PIN, and never on a board with no PIN set, because the roster holds birthdates. The copy in `data/gamesheet.json` is deleted once the game is off the board or 3 h past kickoff. Needs the `board` audience in wiedisync's `scorer-roster.js`. |
| `DIRECTUS_URL` (schedule) | `https://directus.kscw.ch` when unset | Where the **season's home games** come from (`GET /api/schedule`, the console's "start from the schedule" list). A public, token-free read of `/items/games`, so it works without `LIVE_PUBLISH_TOKEN`. The board downloads every remaining home game whenever it has an uplink (at boot, every 30 min, retrying 1→5 min after a failure, and as soon as NTP syncs) and keeps them in `data/schedule.json`, so a hall with no uplink still gets the list — marked stale. No copy at all = a plain "type the names instead" message, never an error. |
| `SCHEDULE_HALLS` | empty (every hall) | Comma list of hall names, e.g. `KWI A,KWI B`: only games in those halls are offered (and prepared automatically). Case-insensitive. |
| `SCHEDULE_SYNC` | on | `0` = no background download and no automatic pre-match; the schedule is then only fetched when a console asks for it. |
| `UPLINK_WATCH` | on | Watch the board's internet and offer the **hall Wi-Fi login** (below). `0` = no background probe. `UPLINK_PROBE_URL` / `UPLINK_PORTAL_URL` point it at a fake portal for testing; they default to Android's `generate_204` and `https://login.pwlan.ch`. |
| `CABLE_TRUST`, `CABLE_ADDRESS`, `CABLE_SUBNET` | on, `192.168.5.1`, `192.168.5.0/24` | **A tablet on the cable is never asked for the scorer PIN** (owner decision 2026-10-22: the cable is a direct, physical connection). A request that arrived on `CABLE_ADDRESS` (the board's eth0) from an address inside `CABLE_SUBNET` (the board itself excluded) passes every PIN gate, on http and https alike, is never counted by the brute-force lock-out, and is told so: `/api/status` answers it `pinRequired:false, pinTrust:"cable"`, `/api/settings` `pinSet:false` (so the tablet app's start-up PIN screen stays down), with `pinConfigured` saying whether the board has a PIN at all. Decided from the TCP connection only — no header, query or `X-Forwarded-For` counts. Everyone else (the board's Wi-Fi `172.24.1.x`, the hall uplink, the tailnet, loopback, a Wi-Fi client aiming at `192.168.5.1`) is gated as before. `CABLE_TRUST=0` switches it off; a malformed address or subnet switches it off too and says so at boot. See `src/cableTrust.js`, `test/cable-trust-selftest.mjs`. |
| `STATE_DIR` | empty (the checkout) | Where everything the appliance **writes** lives: `settings.json` (the scorer PIN with it), `data/` (match history, the resume slot, logs, the schedule copy, the upload ledger, the hall-login stamp, the match-sheet copy) and the boot markers `.sport-switch` and `data/.running`. Empty keeps the paths every board has always used. A board with a **read-only root** sets it to a directory on its persistent data partition (e.g. `STATE_DIR=/data/ledbox`, absolute): on an overlay root anything written elsewhere is lost at the next power cut. Not covered by it, because they belong to the OS or the panel firmware: `/etc/NetworkManager/system-connections`, `/var/lib/tailscale`, the TLS cert dir, the fake-hwclock / timesyncd stamps, and the firmware's own `setting.ini` and `PANEL_OFF` under `/home/pi/ledbox` — a read-only root bind-mounts those itself. A state dir that cannot be written is logged at boot at error level; the board still scores, from memory. `firmware/ledbox-watchdog.sh` reads the same `STATE_DIR` from this `.env`. `test/state-dir-selftest.mjs` fails on any new write path until it is classified. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`; `DEBUG=1` is shorthand for `debug`. |
| `MOCK` | off | `1` = in-process mock LedBox, no hardware. |
| `MATCH_ID` | — | Only the headless `src/bridge.js` needs it; the appliance picks matches in the UI. It is the match's **seed key** (`match_…`, the `id` in the relay's `/api/match/list`, also in the scorer's QR code) — the relay keys rooms by it. The scorer's local numeric match id receives nothing. |

`LEDBOX_LAYOUT` is read by the headless bridge only — the appliance takes its layouts from the
active sport (`src/sports.js`).

### Publishing the board to wiedisync (`/live`)
Optional. Set **both** of these and the appliance mirrors every score change to the
club's Directus, so members can follow the match at `wiedisync.kscw.ch/live`:

| Var | Value |
|---|---|
| `DIRECTUS_URL` | `https://directus.kscw.ch` (dev: `https://directus-dev.kscw.ch`) |
| `LIVE_PUBLISH_TOKEN` | static token of `ledbox-board@kscw.ch` — its policy can touch `live_scores` and nothing else |
| `LIVE_CHANNEL` | which row to write; default `kscw` (one board, one row) |

Leave either blank and the publisher is a **no-op** — the board behaves exactly as
it does without it. Every failure inside it (outage, bad token, slow network) is
swallowed, so it can never affect scoring. These are deliberately distinct from
`RELAY_URL`, which is the LAN relay the board *subscribes* to.

A failed live write is retried with the latest score, backing off and bounded; a new
point during a backoff goes out after the normal debounce instead of waiting it out. A
4xx is not retried. A finished match's history row is resent only when it provably
never reached Directus, so a timeout can lose that row but never duplicate it.

⚠️ Prod and dev have **different** tokens, and the dev one is replaced by the
nightly prod clone. Collection, permissions and setup:
`wiedisync/src/modules/live/DIRECTUS-SETUP.md`.

The publisher sends the active sport, so the app renders the right board — the
sport is fixed at boot (switching it restarts the appliance). Note that
`BasketballSource` carries team fouls in `subs_a`/`subs_b`; `livePush` translates
that to explicit `fouls_a`/`fouls_b` on the wire.

## Test / run
```bash
# everything: source rules + every test/*-selftest.mjs (no network, no hardware; the panel
# driver tests — test:panel — need Linux for flock/pgrep and skip themselves elsewhere)
npm test

# unit test: mapper → client → mock LedBox (no deps, no hardware) — the on-Pi smoke test
npm run test:mapper

# integration tests: mock relay → bridge / appliance → mock LedBox (needs devDeps)
npm install && npm run test:relay

# end to end against the CURRENT OpenVolley relays (manual: needs an OpenVolley checkout with
# backend/ and frontend/ node_modules). Runs one match against each relay family on free ports —
# backend/server.js --local, frontend/server.js (the desktop Node relay, same core as Electron) and
# the Tauri relay (--server-only, when a build exists; skipped otherwise) — and drives the real
# appliance through the network search (the real /api/server/status), Settings, /api/matches and
# /api/link, asserts the panel at every step, exits 1 on any miss
npm run test:e2e                                   # OPENVOLLEY_DIR defaults to ../openvolley/escoresheet
E2E_RELAYS=backend,desktop npm run test:e2e        # a subset; OPENVOLLEY_TAURI_BIN = a Tauri build

# run for real against the built-in mock (no hardware):
MOCK=1 MATCH_ID=match_1759750000000_ab12cd RELAY_URL=ws://127.0.0.1:8080 node src/bridge.js

# run against a real LedBox (MATCH_ID = the seed key, see Configure):
MATCH_ID=match_1759750000000_ab12cd LEDBOX_HOST=172.24.1.1 node src/bridge.js
```

## Appliance — web control UI (manual + link)
Instead of the headless bridge, run the **appliance**: a phone-friendly control page
served by the Pi (`CONTROL_PORT`, default 8890) with two modes — **Manual** (drive the
board by hand: names, ±points, sets, timeouts, subs, serve, swap) and **Link** (list LAN
matches from the relay and mirror one live). Cloud/Supabase source is a stub.

- **Scorer laptop** — the relay Link mode reads from is the scorer's OpenVolley laptop, whose
  address changes from hall to hall. **Settings ▸ Scorer laptop address** takes `host[:port]`
  (`172.24.1.23`, `172.24.1.23:9000`; port 8080 when left out; a pasted `ws://…`/`http://…` URL is
  fine, `wss://host` for a relay on the internet), refused with the reason when malformed and kept
  with the other settings. **Check** saves it and asks the laptop for its matches. Empty (the
  default) = `RELAY_URL` if set, else the board itself, and when nothing answers the board searches
  its own Wi-Fi and cable for a laptop (`RELAY_DISCOVERY`, `src/relayAddress.js`). The Link tab
  names the laptop that answered — or the address it tried and why it failed — and a link
  subscribes to the relay that listed the match. A match is listed by the relay only once the
  scorer has synced it (today's relays also want the referee connection on).
- **End of a linked match** — when the scorer ends the match (`match_status: 'ended'` in the live
  state), the panel shows the result screen (winner, sets; the clock on a board without
  `kscw_result`); an undo of the end brings the score back. When the scorer deletes the match
  (`match-deleted`), the board unlinks (mode `idle`) and holds the clock — or keeps the result if
  it is already up — instead of freezing the last score. Relay `error` frames are logged.

- **Undo** — one button beside the set strip takes back the last action, whatever it was
  (point, timeout, sub, swap, next set, reset), up to 30 steps; it reads what it will undo
  (`Undo · Point KSCW`) and the history log follows it. A second `+` for a team that has
  already won the set is refused instead of scoring (`set-closed`).
- **Schedule and pre-match** — the Link tab lists today's home games and the rest of the season
  (`GET /api/schedule?range=season`: `{ ok, fetchedAt, stale, today, upcoming:[{ date, games }] }`,
  served from the copy on the board's card). Tapping one sets it up behind the wall clock until
  the warm-up ends. With **Settings ▸ Prepare home games automatically** (on by default) the
  board does that tap itself 60 minutes before a game of its sport — once the clock is synced,
  never over a match in progress or a running countdown, the earliest game when two overlap, and
  never again for a game the scorer dismissed that day (`src/autoPrepare.js`).
- **Hall internet** — at a hall whose Wi-Fi has a login page (the KWI hall's `Free_WLAN_KTZH`,
  a Swisscom Public WLAN), live scoring stops until the board is logged in, and the board has no
  browser to do it in. **Settings ▸ Hall internet** does it from the console: the scorer's mobile
  number, then the SMS code; the board walks the portal itself (`src/hallLogin.js`) and stays
  logged in about 24 h. The Game tab shows a banner only while the login page is in the way. The
  number is asked for every time and never stored or logged — the scorer changes every match.
  `GET /api/uplink` → `{ status: online|portal|offline|checking, portal, ssid, validUntil,
  loggedInAt, step: idle|code }`; `POST /api/uplink/check`, `/api/uplink/login { phone }` →
  `{ ok, step:'code' }`, `/api/uplink/code { code }` → `{ ok, status:'online', validUntil }`
  (PIN-gated, always 200 with `{ ok:false, error }` in plain words on a refusal). Both login
  calls also carry the console's `epochMs`: the board has no RTC, and if its clock is behind the
  portal's (freshly renewed) certificate the HTTPS login fails, so it adopts the console's time —
  even mid-match — and tries once more. `/api/status` carries `uplink: { status, validUntil }`. The Wi-Fi itself is set up by
  `provisioning/setup-wlan1-client.sh --hall`, which also carries the DNS fix that network needs.
  When the scripted login cannot get through (the portal slow or changed), **Open the login page**
  shows the hall's own page on the tablet, fetched by the board (`src/portalProxy.js`, under
  `/hall-login/`), so it is still the board that logs in: `POST /api/uplink/portal` (PIN) opens it
  for that tablet for ten minutes, its scripts run sandboxed away from the console's storage, and
  its cookies stay on the board. An offline `/api/uplink` also names the Wi-Fi and says `why`.
- **Portrait works** — a phone held upright gets a stacked layout (left team on top) instead
  of a "rotate" wall; a dismissible tip still suggests landscape.
- **Theme** — **Settings ▸ Theme**: Light (the default), Dark, or E-ink — greyscale, paper white
  and ink black, for a phone courtside in full sun. Per screen, never on the board:
  `localStorage.theme`, shown as `<html data-theme="dark|eink">`, set by a boot script at the top
  of `web/index.html` before the first paint; `/logs` follows it. The looks are token sets on
  `:root`; e-ink carries what colour alone used to (which team, a limit, the chosen tab) as fill
  versus outline, dashes and underlines, and drops shadows and motion. `npm run test:theme`.
- **Inside the Android app** (`android/`, contract `android/BRIDGE.md`) — the app shows this console
  in a kiosk WebView. From app 1.1.0 it draws the header, the tab bar and the Game tab natively, and
  the console runs in *embed mode* under the app's tab bar for Link, History, Diagnostics and
  Settings, with the scorer PIN and the theme shared with the app (BRIDGE.md, "Native Game tab";
  `npm run test:embed`).
- **The tablet's app** — with `TLS_CERT`/`TLS_KEY` set (`provisioning/setup-console-tls.sh`),
  `/api/status` carries `httpsOrigin` (the cert's first DNS name + `HTTPS_PORT`; `null` without
  TLS or once the cert has expired), and a console opened on `http://172.24.1.1:8890` moves itself
  there when it can reach it — between matches, never mid-match (a *Switch* bar until then). From
  the https address Chrome offers **Install app** (`web/manifest.webmanifest`): full screen,
  landscape, screen kept awake from launch, no tap-to-start.
  - **Install it once with internet.** Chrome on Android builds the app (a WebAPK) through
    Google's servers; on the board's own Wi-Fi, which has none, the install can fail or fall back
    to a plain shortcut. Install while the tablet has internet *and* reaches the board by its
    tailnet name (Tailscale on the tablet, or the hall Wi-Fi when the board shares it), then launch
    it once on the board's Wi-Fi to check it opens full screen, landscape, and stays lit.
  - **The app is bound to that exact origin.** Renaming the tailnet node or changing
    `HTTPS_PORT` means uninstalling and installing it again.
  - **The first move to https asks for the PIN again.** Browser storage is per origin, so the
    https console starts without what the http one remembered (scorer PIN, keep-awake, the
    dismissed rotate tip). Once only.
  - **If the app opens on "The board didn't answer here"**, the tablet could not look the name up
    or reach it (Private DNS or Chrome Secure DNS set to a provider, mobile data carrying DNS, the
    tablet on another network). That page is `web/sw.js` — a service worker that caches nothing
    and only answers a page load that failed — and it links `http://172.24.1.1:8890`, which still
    works. A lapsed certificate shows Chrome's own warning page instead (no worker runs there):
    use the same plain address.
```bash
npm run appliance                 # open http://<pi-ip>:8890  (or http://openvolley:8890 over Tailscale)
MOCK=1 npm run appliance          # in-process mock LedBox, no hardware
npm run test:appliance            # API → source → mapper → mock LedBox integration test
```
Architecture and the remaining phases (cloud source, auth, persistence) are in
[`DESIGN-appliance.md`](./DESIGN-appliance.md).

## Logs — `/logs`
Everything the appliance does is recorded to one structured log: board writes and layout
switches, every scored action, source and relay lifecycle, settings changes, live-scoring
publishes, and the browser's own errors. Open **`http://<board-ip>:8890/logs`** (linked from
Settings ▸ Diagnostics) for a live tail with level/scope filters, search, download and a
runtime verbosity switch.

```bash
LOG_LEVEL=debug npm run appliance   # boot verbose (DEBUG=1 still works); also switchable at /logs
curl http://<board-ip>:8890/api/logs/export > board.jsonl  # the whole trail, for a bug report
journalctl -u ledbox-bridge -f                             # unchanged — everything still mirrors to stdout
```

Persisted to `data/logs/*.jsonl`, rotated at 5 MB × 3 files (**15 MB ceiling**, SD-card
friendly). The scorer PIN, the Directus token and any phone number are redacted before anything
is written.
Design notes: [`docs/logging-DESIGN.md`](./docs/logging-DESIGN.md).

## Deploy on the Pi (systemd)
```bash
# on the Pi (reachable as `ssh openvolley`):
cd ~/ledbox-bridge
cp .env.example .env && nano .env        # optional — the defaults drive the board (see Configure)
sudo cp systemd/ledbox-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ledbox-bridge
journalctl -u ledbox-bridge -f
```

## Status / open items
- **Validated:** mapper + protocol + TCP client + relay subscriber, on the Pi 5 against
  mocks (`npm test`).
- **Wired (app side):** the Scoreboard now also pushes its computed live-state over the
  LAN relay as a `live-state-update` message (`Scoreboard.jsx`); `server.js` merges it
  into the match store and fans it out to subscribers, and the bridge consumes it.
  Verified with mocks — still needs a live end-to-end run with a real scoreboard + relay.
- **Pending (hardware):** confirm the real LedBox's `volleyball_matchscore` section
  names — especially `sub1`/`sub2` and the team-name fields — and upload a custom
  layout via TCP :12345 if they differ.
