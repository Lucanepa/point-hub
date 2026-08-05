# Wrist remote — scoring the board without the tablet

Status: **designed, not built.** The board-side half is specified and ready to implement. The
wrist device itself is undecided, pending one five-minute test (see [Which
device](#which-device-the-part-that-is-still-open)).

## Why

The tablet works, and it is not going away — it owns team names, timeouts, subs, serve, the
set-end interval, the court-switch confirmation and the result screen. But scoring a rally means
looking down, finding the right half of a 10-inch screen and tapping it. A scorer who is also
watching the court wants one thing: **point left, point right**, without looking away.

So this is a *secondary* remote. The tablet stays authoritative. The remote adds points and
nothing else — which is what makes it small enough to be worth building.

## Shape

```
 wrist device ──┐
                │  POST /api/action  {id, action:{type:'point', side, delta:±1}}
                │  GET  /api/state/stream   (SSE, new)
                ▼
 tablet ─────▶ controlServer :8890 ─▶ SourceManager ─▶ manualSource ─▶ mapper ─▶ LedboxClient ─▶ 📟
                                            │
                                            └─ 'state' event ─▶ SSE subscribers
```

The remote is just another HTTP client. It never talks to the panel, never holds match state of
its own, and can be unplugged mid-match with no consequence beyond the operator going back to
tapping the tablet.

### Why a native client passes the guards for free

`handleApi` refuses any mutating request that carries a foreign `Origin`, and any that is not
`application/json` (`src/controlServer.js:357-367`). Both are free for a non-browser client:
`isSameOrigin()` (`src/controlServer.js:978`) treats an **absent** `Origin` as same-origin, which
is what already lets curl, the selftests and `deploy-board.sh` through. An HTTP client from an app
or a microcontroller sends no `Origin` at all.

`POST /api/action` is also self-sufficient: it installs the manual source if it isn't active and
lifts the idle/crest screen before applying (`src/controlServer.js:405-410`). **One POST takes the
board off the crest and starts scoring** — the remote never needs `/api/manual`, `/api/game` or
`/api/link`.

## Board side — three additions

All three are additive and backwards-compatible. A client that ignores them sees today's
behaviour exactly.

### 1. Idempotency key on `/api/action`

`manualSource.apply(action)` runs unconditionally (`src/controlServer.js:411`). There is no
request id, sequence number or dedupe anywhere in the API. So a POST that times out but actually
landed, then gets retried, **scores twice in front of the hall**.

The console avoids this entirely client-side, with a single-flight gate and a generation counter
(`web/index.html:1696-1739`) — and the comments there record what it cost to learn:

> One action at a time. On a lagged link the board doesn't move for a second or two, the operator
> taps again, and BOTH taps land — which is how one rally becomes two points.

A tablet sitting on the board's own AP is the *best* case for that gate. A wrist device on a
flaky radio, or relayed through a phone over Bluetooth, is materially more retry-prone. So the
retry has to become safe on the server, not just discouraged on the client.

```jsonc
POST /api/action
Content-Type: application/json
X-Scorer-Pin: <pin>
{ "id": "a3f1-0007", "action": { "type": "point", "side": "left", "delta": 1 } }
```

`id` is a client-generated opaque string, `[\w.-]{1,64}`, scrubbed like every other client input.
Anything longer or malformed is treated as absent rather than rejected — a remote with a broken id
generator should still be able to score.

The server keeps a `Map` of `id → the exact {ok, state, event} it returned`, bounded at **256
entries** and a **120 s** TTL, evicted oldest-first. A repeat `id` replays the cached response
**without** calling `apply`. Omit `id` and nothing changes.

Keyed on `id` alone, not on `id`+IP — a client that reconnects on a different address must still
dedupe.

**Why not the absolute form instead.** `{type:'point', side, value:N}` is already retry-safe, and
it is a trap. It deliberately bypasses the rally engine (`src/manualSource.js:140-149`): no serve
change, no set-win detection, no event. A remote built on it would never fire `set-end`, and the
board would play past 25 forever. It exists for typed operator corrections, and that is all.

### 2. Viewer class

`noteViewer()` is the first statement of `handleApi` (`src/controlServer.js:348`), with the
rationale in the comment above it: any API traffic means an operator has the control UI open, and
the board uses that to drop its "how do I connect" QR screen for a wall clock.

A remote polling in the background satisfies that test permanently. The QR screen would never come
back for the next person who needs it.

Rule: **a mutating call always counts as a viewer; a background read from a remote does not.**

A remote sends `X-Client-Class: remote`. `noteViewer()` is skipped only when that header is present
*and* the method is GET or HEAD. Scoring from the wrist still counts — someone is plainly present.
Any client that omits the header is unchanged, so the tablet needs no edit.

### 3. SSE state stream

There is no push channel for match state. The console polls `/api/status` on a self-scheduling
1500 ms timer; `DESIGN-appliance.md` lists a `WS /ws` status push as designed and never built.
40 radio wakes a minute is hostile to anything battery-powered.

`GET /api/state/stream` copies the plumbing already at `src/controlServer.js:757` (chosen over a
WebSocket there for the same reasons that apply here), fed by the `state` event `SourceManager`
already re-emits upward (`src/sourceManager.js:37`).

- First frame is the full `/api/status` envelope, so a client needs no separate GET on connect.
- Heartbeat comment every ~20 s so dead connections are detected.
- A client that loses the stream falls back to polling and keeps working.

No new dependency — load-bearing, because the board is armhf and pinned to Node 22 until
2027-04-30, and zero production dependencies is what keeps that cheap.

## The remote contract

Written down because more than one device may end up implementing it, and the board side should be
built and tested once.

### Calls

| | |
|---|---|
| `GET /api/status` | Open, no PIN, no `Origin` needed. Or subscribe to `/api/state/stream`. |
| `POST /api/action` | `{id, action:{type:'point', side:'left'\|'right', delta:1}}`. Undo is `delta:-1`. |
| `POST /api/unlock` | `{pin}` → `200 {ok:true}` / `200 {ok:false}` / `429`. Once, at pairing. |

There is no undo route and no undo stack. `delta:-1` is the undo, and walking a score back below
the winning condition correctly pops a wrongly-awarded set (`src/manualSource.js:181-189`) — a
behaviour that exists because a mis-tapped 25-23 once counted the set twice.

`/api/unlock` returns no token. There is no session concept, so the remote stores the PIN and
resends it in `X-Scorer-Pin` on every mutating request.

### State it reads

From `status.state` (`src/manualSource.js:110-123`):

| Field | Use |
|---|---|
| `side_a` | Resolve a/b → physical left/right. Manual sources hard-code `'left'`; the LAN source can send `'right'`. Honour it. |
| `points_a`, `points_b` | The two big numbers. |
| `sets_won_a`, `sets_won_b` | The sets line. |
| `team_a_short`, `team_b_short` | Side labels, uppercase, ≤12 chars. |
| `team_a_color`, `team_b_color` | `#rrggbb` side tint. |
| `serving_team` | `'left'\|'right'\|null` — cheap, and the best single cue that a tap landed. |

From the envelope: `pinRequired`, `sport`, `ledbox.connected`.

Not needed: `timeouts_a/b`, `subs_a/b`, `set_results`, `mode`, `matchId`, `ledbox.host/port/layout`.

### Seven client invariants

The server provides none of these. Every one is copied from the console, where it was learned the
hard way.

1. **One action in flight.** Gate every send; refuse the second tap and say so.
2. **Never auto-retry without an `id`.** With one, retry freely.
3. **Monotonic render ticket.** Discard a status reply older than what is drawn, or an in-flight
   read repaints the pre-tap score over a just-applied point.
4. **Merge over the last full status, don't replace.** The POST reply carries `state` but not
   `sport` or `pinRequired`.
5. **Key the UI on physical left/right, never a cached team identity.** `_swap()`
   (`src/manualSource.js:279`) moves names, colours, points, sets *and* set_results across on every
   change of ends. A remote that caches "my team is A" will silently show the opponent.
6. **`403` → forget the PIN and re-prompt. `429` → honour `Retry-After` and stop.** The console
   keys its re-prompt on 403, not 401.
7. **Two consecutive failed reads → freeze the display and say so**, with the wall-clock time it
   froze at. A stale score shown confidently is the worst failure mode on a wrist.

### Events must not be swallowed

`POST /api/action` returns `event`: `null | 'set-end' | 'match-end' | 'switch-due'`
(`src/controlServer.js:434`).

The tablet owns every confirmation dialog — the interval countdown is client-owned, the set-end
prompt is a non-modal client prompt, and the court switch is an operator confirmation that then
sends `swap`. Reimplementing that on a wrist is most of the project, and it is explicitly out of
scope.

But the remote must not score silently through them. It **surfaces** the event ("Set won — start
the interval on the tablet") so the operator is never left waiting on a prompt they cannot see.

`switch-due` matters most, and its cadence differs by sport:

- **Indoor:** the deciding set only, when either side first reaches 8 (`DECIDER_SWITCH_AT`,
  `src/manualSource.js:176-179`).
- **Beach:** every 7 points of the combined score, every 5 in the decider
  (`src/beachSource.js`, asserted in its own selftest).

Neither source auto-swaps — by design. If the remote swallows `switch-due`, the board goes out of
sync with the court.

### Sport gate

Volleyball and beach score normally; points and sets are truthful for both.

**Basketball refuses.** `sets_won_a/b` are hard-coded 0 (`src/basketballSource.js:114`, and
asserted in its selftest), so a points-and-sets remote would show `0 – 0` for the entire game. Its
real structural field is `period`, and it needs +1/+2/+3 deltas rather than a single +1. The remote
reads `status.sport` and, on basketball, shows "use the tablet" rather than rendering a lie.

## Error handling

**Two kinds of down.** `ledbox.connected` distinguishes *the panel is unreachable* from *the
appliance is unreachable*. They need different words on screen; the console already separates them.

**PIN lockout is shared.** `PinGate` allows 5 free failures per source IP, then 30 s doubling to a
5-minute ceiling, forgotten after 10 minutes of quiet and cleared on success. It is keyed on
`req.socket.remoteAddress` with no `X-Forwarded-For` handling — so a remote behind the same NAT as
the tablet **shares its budget and can lock the scorer out**. Hence: validate the PIN once at
pairing via `/api/unlock`, never on every launch.

The shipped default is an empty PIN (`src/settings.js:39`), meaning the gate is off and anything in
RF range can score. Adding a second always-connected client is the moment to require one. The
remote refuses to pair with a board reporting `pinRequired: false`.

**Sport switches restart the appliance** for 6–8 s. The remote rides it out rather than erroring;
the console already does exactly this by polling for 25 s.

**Accidental input is a phantom point on a live scoreboard.** Whatever the device, the remote is
armed explicitly and defaults to disarmed. A first touch wakes the screen and never scores; once
awake, one tap is one point, applied immediately, with an undo affordance visible for a few
seconds afterwards.

## Testing

`test/remote-selftest.mjs`, in the house style, wired into `npm test`:

- A replayed `id` scores **once**; the second call returns the identical cached body.
- An action with **no** `id` behaves byte-identically to today.
- A remote-classed **read** does not register a viewer; a remote-classed **point** does.
- `/api/state/stream` delivers the opening snapshot, then a frame after a scored point.
- `403` and `429` bodies are the shapes clients branch on.

## Which device — the part that is still open

The original plan was a Wear OS app on a **Huawei Watch D2**. That is settled and it is a no:

- **No Wi-Fi radio.** Confirmed by the D2's EU RED frequency-band declaration, which lists its
  complete transmit set as Bluetooth 2.4 GHz, NFC 13.56 MHz and wireless charging 110–140 kHz. A
  manufacturer may not legally omit a transmit band from that table. No LTE, no eSIM, no USB data.
- **Huawei blocks the network API in Europe.** Their own lite-wearable documentation states that
  sports watches in Europe cannot initiate `fetch` requests, listed as a cause of failure with no
  remedy offered. `@system.fetch` is the only network API on this device class.

Worth recording so it is not re-litigated: the *app platform* is **not** the obstacle. The D2 is a
first-class SDK target (`WATCH D2 | 408 × 480 | API 12`) and there is a documented self-serve
sideload path needing no AppGallery review. You can put buttons on that watch. They just cannot
reach the board.

The remaining candidates, in the order they should be considered:

| Option | Cost | Gets you |
|---|---|---|
| Media-session hack | CHF 0 | Watch's music remote drives the phone's media session; next/prev become point right/left, score shows as track title. **Pending one test.** |
| Used Wear OS watch | ~CHF 50–90 | The thing originally asked for. Own Wi-Fi, direct to the board, normal `adb` loop. |
| BLE HID clicker or ring | ~CHF 10–40 | Key events into the existing page. Most reliable, no display. |
| ESP32 clicker | ~CHF 20–25 | Two tactile buttons plus a screen, joins the AP directly. You own the firmware. |

### The media-session route, and the one test that decides it

`navigator.mediaSession` is **not** secure-context gated — verified in the W3C source, in Blink,
Gecko and WebKit IDL, and empirically in Chrome 151 on a plain-HTTP private-IP origin where
`wakeLock`, `serviceWorker` and `crypto.subtle` were all absent.

That is worth noting on its own, because `web/index.html:2805` records the wakeLock failure on this
origin and the reasonable inference is that the whole class of modern API is unavailable here. It
is not. Media Session carries no `[SecureContext]` where `navigator_wake_lock.idl` does.

Two things stand between that and a working remote:

**Silent audio does not work.** Chrome clamps exactly this trick — muted or `volume=0` produces no
session at all, and audio focus is deferred until the page is measurably *audible* (above roughly
−72.25 dBFS). So the feature is "the scorer's phone hums quietly for the whole match". That is a
product decision, not an implementation detail. Note the existing NoSleep video
(`web/index.html:2826`, `v.muted = true`) can never serve this purpose — it is precisely the
configuration that guarantees no session. A second, audible element would sit alongside it.

**Nobody has ever confirmed a Huawei watch controlling browser audio.** The remote is confirmed
app-agnostic for real media apps, but a Chrome tab has no first-hand report anywhere searched. The
test costs five minutes and no code:

> Play a video in **Chrome** (not the YouTube app) on the paired phone, with the volume audibly up.
> Wait 30 s. Does the watch's music card show the video's **title**? Do **next/previous** reach the
> tab? Does the title **update** when you switch videos?

If the card never appears, the route is dead and no code changes that — a native app depends on the
same binding. If it works, it is roughly 30 lines in `web/index.html`, reusing the existing
`sendAction()` so swap semantics, the PIN and undo all come along for free.

Structural limit either way: **the watch must be on the music screen to score**, which is a real
cost against the wake-then-score flow.

## Build order

1. **Board side** — the three additions plus `test/remote-selftest.mjs`. Blocked by nothing,
   needed by every candidate device, and useful to the tablet on its own.
2. **The five-minute test** — decides the wrist client at zero cost.
3. **The client** — chosen by (2).

## Open questions

- Whether Huawei Health binds its watch music card to a Chrome media session at all. Test above.
- How quiet the keepalive tone can be before the session drops, and whether silencing the phone
  kills it. Both are operational kill criteria if they land badly.
- Whether background survival needs Chrome set to "Unrestricted" battery usage per device. A
  per-phone Android setting is not a shippable prerequisite; that result would force a native app.
- Whether the board's internal Pi has usable Bluetooth, if a BLE-bridged device is ever chosen.
  Unverified — one `hciconfig` answers it.
- Concurrent writers. Nothing server-side sequences or de-duplicates across *devices*: the remote
  and the tablet can both score the same rally. A lease is the honest fix and is deliberately out
  of scope, because a stale lease that locks the scorer out mid-match is worse than the problem. For
  now: convention, plus a visible warning when the score moves between the remote's own writes.
