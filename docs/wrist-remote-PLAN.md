# Wrist remote (board side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the appliance safe and cheap for a battery-powered wrist device to score against, without changing anything a current client sees.

**Architecture:** Three additive changes to `src/controlServer.js` — an idempotency cache on `POST /api/action`, a viewer-class opt-out on `noteViewer()`, and a `GET /api/state/stream` SSE endpoint fed by the `state` event `SourceManager` already emits. One new selftest covers all three.

**Tech Stack:** Node 22, ESM, zero production dependencies, `node:http` only. Tests are hand-rolled `.mjs` scripts run directly by `node`, not a framework.

## Global Constraints

- **Zero production dependencies.** The board is armhf and pinned to Node 22 until 2027-04-30. Do not add a package. `node:*` builtins only.
- **Every change is additive and backwards-compatible.** A client that sends none of the new fields or headers must observe byte-identical behaviour.
- **Never break scoring.** Persistence and logging are already wrapped so a fault in them cannot break a point. Hold the same line.
- **House test style:** a `.mjs` script, `let pass = 0, fail = 0`, an `ok(cond, label)` helper printing `✅`/`❌`, ending in `process.exit(fail ? 1 : 0)`. No test framework.
- **Comments explain WHY, not what.** This codebase's comments record incidents. Match that.
- **Spec:** `docs/wrist-remote-DESIGN.md`. Read it before starting.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/controlServer.js` | HTTP control API | Modify — 3 additions |
| `test/remote-selftest.mjs` | Proves all three hold | Create |
| `package.json` | Test wiring | Modify — 2 lines |
| `docs/wrist-remote-DESIGN.md` | Spec | Modify — status line |
| `README.md` | Operator-facing docs | Modify — one section |

`src/controlServer.js` is ~1170 lines and already large. It is not being split here: all three additions sit inside `createControlServer` next to the code they extend, and a split would be a much bigger change than this feature justifies.

**Do not touch** `test/control-auth-selftest.mjs`. It greps `controlServer.js` for `pathname === '/api/...' && req.method === 'POST'|'PUT'|'DELETE'` and fails the build on an unclassified *mutating* route. The route added here is GET-only, so it is correctly invisible to that check. If you find yourself editing that file, you have added a mutating route and need to classify it there.

---

### Task 1: Idempotency key on `POST /api/action`

**Files:**
- Modify: `src/controlServer.js` (constants near line 53; `createControlServer` body near line 181; the `/api/action` route at lines 390-434)
- Create: `test/remote-selftest.mjs`
- Modify: `package.json` (`scripts.test`, `scripts.test:remote`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `test/remote-selftest.mjs` exporting nothing but defining, for Tasks 2 and 3 to reuse — `ok(cond, label)`, `PIN` (`'4242'`), `app`, `port`, `base`, `postTo(port, origin)`, `post(route, body, {pin, clientClass})`, `get(route, {clientClass})`, `points()`. Task 2 and Task 3 append their blocks to this same file, before the teardown.

- [ ] **Step 1: Write the failing test**

Create `test/remote-selftest.mjs`:

```js
// Does the board keep its side of the wrist-remote contract?
//
// Three things this file exists to stop regressing, none of them covered anywhere else:
//
//   1. A retried POST /api/action must score ONCE. Nothing in the protocol dedupes, so a remote
//      that times out on a request the board already applied and then does the honest thing —
//      retry — put a second point on the panel in front of the hall.
//   2. A remote's background polling must not register as a viewer. noteViewer() is how the board
//      decides to drop its "how do I connect" QR screen for a wall clock; a wrist device polling
//      forever suppresses that QR for the next person who needs it.
//   3. /api/state/stream must OPEN with a full status envelope and then push on every change. A
//      client that has to GET /api/status after connecting is a client that races its own stream.
//
// Spec: docs/wrist-remote-DESIGN.md

import { setTimeout as sleep } from 'node:timers/promises'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startAppliance } from '../src/appliance.js'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}`) } }

const PIN = '4242'

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-remote-'))
fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({ scorerPin: PIN, sport: 'volleyball' }))

const app = await startAppliance({
  stateDir,
  relayUrl: '', relayHttpUrl: '', matchId: '',
  ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0,
  mock: true, controlPort: 0, debug: false,
})
const port = app.server.address().port
const base = `http://127.0.0.1:${port}`
await sleep(200)

// Origin rides on every mutating call because the server refuses cross-origin mutations outright;
// without it we would be measuring the CORS guard rather than the thing under test.
const postTo = (p, origin) => (route, body, { pin = PIN, clientClass } = {}) => {
  const payload = JSON.stringify(body ?? {})
  const headers = {
    origin,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  }
  if (pin !== undefined) headers['X-Scorer-Pin'] = pin
  if (clientClass) headers['X-Client-Class'] = clientClass
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: p, path: route, method: 'POST', headers }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}
const post = postTo(port, base)
const get = (route, { clientClass } = {}) =>
  fetch(base + route, { headers: clientClass ? { 'X-Client-Class': clientClass } : {} })
const points = async () => {
  const s = await (await get('/api/status')).json()
  return `${s.state.points_a}-${s.state.points_b}`
}

try {
  console.log('\nan idempotency key makes a retry safe:')
  {
    const id = 'wrist-0001'
    const body = { id, action: { type: 'point', side: 'left', delta: 1 } }
    const first = await post('/api/action', body)
    ok(first.status === 200, `first POST -> 200 (got ${first.status})`)
    ok(await points() === '1-0', `it scored (${await points()})`)

    const again = await post('/api/action', body)
    ok(again.status === 200, `the retry -> 200 (got ${again.status})`)
    ok(await points() === '1-0', `and it did NOT score again (${await points()})`)
    ok(JSON.stringify(again.body) === JSON.stringify(first.body), 'the retry replays the identical body')
  }

  console.log('\nwithout an id nothing changes — today\'s behaviour exactly:')
  {
    const before = await points()
    await post('/api/action', { action: { type: 'point', side: 'right', delta: 1 } })
    await post('/api/action', { action: { type: 'point', side: 'right', delta: 1 } })
    const after = await points()
    ok(before === '1-0' && after === '1-2', `two un-idded points both landed (${before} -> ${after})`)
  }

  console.log('\na malformed id is ignored, not refused — a broken generator must still score:')
  {
    const before = await points()
    const r = await post('/api/action', { id: 'no spaces allowed!', action: { type: 'point', side: 'left', delta: 1 } })
    ok(r.status === 200, `-> 200 (got ${r.status})`)
    const after = await points()
    ok(after === '2-2' && after !== before, `and it scored anyway (${before} -> ${after})`)
  }
} finally {
  await app.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/remote-selftest.mjs`

Expected: FAIL. The retry scores a second point, so `and it did NOT score again` reports `2-0`, and the later assertions shift. Exit code 1.

- [ ] **Step 3: Add the constants**

In `src/controlServer.js`, immediately after the `HEX_COLOR` constant (line 53):

```js
// A retried POST /api/action must not score twice. Nothing in the protocol dedupes: there is no
// sequence number, no request id and no rate limit on this route. The console gets away with it
// by never retrying (single-flight gate, web/index.html:1696) — but that is a tablet sitting on
// the board's own AP. A wrist device on a sleeping radio, or relayed through a phone over
// Bluetooth, times out on requests the board already applied, and the honest client behaviour
// then puts the second point on the panel in front of the hall.
//
// Bounded on purpose: this is an SD-card Pi, and an unbounded Map keyed on client-supplied
// strings is a memory leak with a remote trigger.
const ACTION_ID = /^[\w.-]{1,64}$/
const ACTION_REPLAY_MAX = 256
const ACTION_REPLAY_TTL_MS = 120000
```

- [ ] **Step 4: Add the replay cache inside `createControlServer`**

In `src/controlServer.js`, immediately after the `denyPin` function (ends line 214):

```js
  // id -> { at, body }: the exact response that id already produced. Insertion-ordered, which is
  // what makes the eviction below oldest-first for free.
  const actionReplay = new Map()
  const replayGet = (id, now) => {
    const hit = actionReplay.get(id)
    if (!hit) return null
    if (now - hit.at > ACTION_REPLAY_TTL_MS) { actionReplay.delete(id); return null }
    return hit.body
  }
  const replayPut = (id, body, now) => {
    actionReplay.set(id, { at: now, body })
    while (actionReplay.size > ACTION_REPLAY_MAX) {
      actionReplay.delete(actionReplay.keys().next().value)
    }
  }
```

- [ ] **Step 5: Wire it into the `/api/action` route**

In `src/controlServer.js`, in the `/api/action` route. Find this (line 392-393):

```js
      const body = await readJson(req)
      const action = body && body.action
```

Replace with:

```js
      const body = await readJson(req)
      // A malformed id is treated as ABSENT rather than refused: a remote with a broken id
      // generator should still be able to score, and ignoring it is exactly today's behaviour.
      const rawId = body && body.id
      const actionId = typeof rawId === 'string' && ACTION_ID.test(rawId) ? rawId : null
      if (actionId) {
        const cached = replayGet(actionId, Date.now())
        if (cached) {
          alog.info(`replayed action id ${actionId} — not scored again`, { id: actionId, ip: clientIp(req) })
          return sendJson(res, 200, cached)
        }
      }
      const action = body && body.action
```

Then find the route's final line (line 434):

```js
      return sendJson(res, 200, { ok: true, state: newState, event: manualSource.lastEvent })
```

Replace with:

```js
      const payload = { ok: true, state: newState, event: manualSource.lastEvent }
      if (actionId) replayPut(actionId, payload, Date.now())
      return sendJson(res, 200, payload)
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node test/remote-selftest.mjs`

Expected: PASS — 8 passed, 0 failed.

- [ ] **Step 7: Wire it into `npm test`**

In `package.json`, append to the end of the `scripts.test` string:

```
 && node test/remote-selftest.mjs
```

So the tail reads `... && node test/console-shell-selftest.mjs && node test/remote-selftest.mjs`.

And add a focused script next to the other `test:*` entries:

```json
    "test:remote": "node test/remote-selftest.mjs",
```

- [ ] **Step 8: Run the whole suite**

Run: `npm test`

Expected: every selftest passes. Pay attention to `test/control-auth-selftest.mjs` — it asserts every mutating route is classified, and `/api/action` gained a field but not a new route, so it must stay green.

- [ ] **Step 9: Commit**

```bash
git add src/controlServer.js test/remote-selftest.mjs package.json
git commit -m "Make a retried point score once, not twice"
```

---

### Task 2: Viewer class

**Files:**
- Modify: `src/controlServer.js` (`handleApi` head, lines 345-348)
- Modify: `test/remote-selftest.mjs` (append a block inside the existing `try`)

**Interfaces:**
- Consumes: `ok`, `PIN`, `postTo`, `sleep`, `fs`, `os`, `path`, `startAppliance` from Task 1's file.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

In `test/remote-selftest.mjs`, inside the `try` block, after the malformed-id block and before the closing `}` of `try`:

```js
  console.log('\na remote\'s reads leave no viewer, but its writes do:')
  {
    // Its own appliance on purpose: viewerPresent() is sticky for viewerTimeoutMs, so the
    // "nobody has connected yet" assertion is only meaningful on a board nothing has touched.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-remote-viewer-'))
    fs.writeFileSync(path.join(dir2, 'settings.json'), JSON.stringify({ scorerPin: PIN, sport: 'volleyball' }))
    const app2 = await startAppliance({
      stateDir: dir2,
      relayUrl: '', relayHttpUrl: '', matchId: '',
      ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0,
      mock: true, controlPort: 0, debug: false,
    })
    const port2 = app2.server.address().port
    const base2 = `http://127.0.0.1:${port2}`
    const post2 = postTo(port2, base2)
    await sleep(200)
    try {
      ok(app2.ledbox.viewerPresent() === false, 'a freshly booted board has no viewer')

      await fetch(base2 + '/api/status', { headers: { 'X-Client-Class': 'remote' } })
      ok(app2.ledbox.viewerPresent() === false, 'a remote GET /api/status still leaves none')

      const scored = await post2('/api/action', { action: { type: 'point', side: 'left', delta: 1 } }, { clientClass: 'remote' })
      ok(scored.status === 200, `a remote point -> 200 (got ${scored.status})`)
      ok(app2.ledbox.viewerPresent() === true, 'but it DOES register one — someone scoring is plainly present')

      // The console must be unaffected: it sends no X-Client-Class at all.
      const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ledbox-remote-console-'))
      fs.writeFileSync(path.join(dir3, 'settings.json'), JSON.stringify({ scorerPin: PIN, sport: 'volleyball' }))
      const app3 = await startAppliance({
        stateDir: dir3,
        relayUrl: '', relayHttpUrl: '', matchId: '',
        ledboxAlias: 'test', ledboxApiVersion: 2, reconnectMs: 0,
        mock: true, controlPort: 0, debug: false,
      })
      await sleep(200)
      try {
        ok(app3.ledbox.viewerPresent() === false, 'a second fresh board has no viewer either')
        await fetch(`http://127.0.0.1:${app3.server.address().port}/api/status`)
        ok(app3.ledbox.viewerPresent() === true, 'an ordinary GET (the console) registers one, unchanged')
      } finally {
        await app3.close()
        fs.rmSync(dir3, { recursive: true, force: true })
      }
    } finally {
      await app2.close()
      fs.rmSync(dir2, { recursive: true, force: true })
    }
  }
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/remote-selftest.mjs`

Expected: FAIL on `a remote GET /api/status still leaves none` — today every API call calls `noteViewer()`, so it returns `true`.

- [ ] **Step 3: Implement**

In `src/controlServer.js`, replace lines 345-348:

```js
  async function handleApi(req, res, pathname) {
    // Any API traffic means an operator has the control UI open (it polls /api/status every
    // 1.5s). The board uses this to drop the "how do I connect" QR codes for a wall clock.
    if (ledbox && typeof ledbox.noteViewer === 'function') ledbox.noteViewer()
```

with:

```js
  async function handleApi(req, res, pathname) {
    // Any API traffic means an operator has the control UI open (it polls /api/status every
    // 1.5s). The board uses this to drop the "how do I connect" QR codes for a wall clock.
    //
    // A wrist remote polling in the background satisfies that test forever, and the QR screen
    // would then never come back for the next person who needs it. So a remote's READS do not
    // count — but its writes do, because someone scoring is plainly present. A client that sends
    // no X-Client-Class (the console, the mirror, curl) is unaffected.
    const remoteRead = (req.method === 'GET' || req.method === 'HEAD') &&
      String(req.headers['x-client-class'] || '').toLowerCase() === 'remote'
    if (!remoteRead && ledbox && typeof ledbox.noteViewer === 'function') ledbox.noteViewer()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/remote-selftest.mjs`

Expected: PASS — 14 passed, 0 failed (8 from Task 1 plus the 6 here).

- [ ] **Step 5: Run the whole suite**

Run: `npm test`

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/controlServer.js test/remote-selftest.mjs
git commit -m "Stop a polling remote from hiding the connect-QR screen forever"
```

---

### Task 3: `GET /api/state/stream`

**Files:**
- Modify: `src/controlServer.js` (new route after the `/api/board` route, line 375)
- Modify: `test/remote-selftest.mjs` (append a block inside the existing `try`)

**Interfaces:**
- Consumes: `ok`, `post`, `base`, `sleep` from Task 1's file.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

In `test/remote-selftest.mjs`, inside the `try` block, after the viewer block:

```js
  console.log('\n/api/state/stream opens with a full status envelope, then pushes:')
  {
    const frames = []
    const ac = new AbortController()
    const res = await fetch(base + '/api/state/stream', {
      headers: { 'X-Client-Class': 'remote' },
      signal: ac.signal,
    })
    ok(res.status === 200, `-> 200 (got ${res.status})`)
    ok(String(res.headers.get('content-type') || '').startsWith('text/event-stream'),
      `content-type is text/event-stream (got ${res.headers.get('content-type')})`)

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    // Aborting the fetch below rejects this read; that is the intended exit, not a failure.
    const pump = (async () => {
      while (frames.length < 2) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const line = chunk.split('\n').find((l) => l.startsWith('data: '))
          if (line) frames.push(JSON.parse(line.slice(6)))
        }
      }
    })().catch(() => {})

    await sleep(150)
    const before = frames[0] ? frames[0].state.points_b : 0
    await post('/api/action', { id: 'sse-0001', action: { type: 'point', side: 'right', delta: 1 } })
    await Promise.race([pump, sleep(2000)])
    ac.abort()

    ok(frames.length >= 1, `an opening frame arrived (${frames.length} frames total)`)
    ok(!!frames[0] && frames[0].sport === 'volleyball' && frames[0].pinRequired === true,
      'the opening frame is a full status envelope (carries sport and pinRequired), not a bare state')
    ok(!!frames[0] && !!frames[0].state && typeof frames[0].state.points_a === 'number',
      'and it carries the live state')
    ok(frames.length >= 2, `a scored point pushed a second frame (${frames.length})`)
    ok(frames.length >= 2 && frames[1].state.points_b === before + 1,
      'and that frame shows the new score')
  }
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node test/remote-selftest.mjs`

Expected: FAIL — the route does not exist, so the status assertion reports 404 and the content-type assertion reports `application/json`.

- [ ] **Step 3: Implement**

In `src/controlServer.js`, immediately after the `/api/board` route (which ends line 375), insert:

```js
    // GET /api/state/stream — Server-Sent Events for match state. Same reasoning as
    // /api/logs/stream: no ws dependency in production and SSE reconnects on its own. The console
    // polls /api/status every 1.5s, which is fine for a tablet on mains power and hostile to
    // anything on a battery — 40 radio wakes a minute to learn nothing changed.
    if (pathname === '/api/state/stream' && req.method === 'GET') {
      res.writeHead(200, {
        ...res._cors,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // The whole status envelope, not just the state: it carries sport, pinRequired and
      // ledbox.connected, which a client would otherwise have to GET separately and race.
      const frame = () => { try { res.write(`data: ${JSON.stringify(status())}\n\n`) } catch { /* client went away */ } }
      frame()
      const onState = () => frame()
      sourceManager.on('state', onState)
      // Proxies and phones drop an idle connection; a comment frame every 20s keeps it up.
      const keepAlive = setInterval(() => { try { res.write(': keep-alive\n\n') } catch { /* ignore */ } }, 20000)
      if (keepAlive.unref) keepAlive.unref()
      const done = () => { clearInterval(keepAlive); sourceManager.off('state', onState) }
      req.on('close', done)
      req.on('error', done)
      return
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/remote-selftest.mjs`

Expected: PASS — 21 passed, 0 failed (14 from Tasks 1-2 plus the 7 here).

- [ ] **Step 5: Run the whole suite**

Run: `npm test`

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/controlServer.js test/remote-selftest.mjs
git commit -m "Push state over SSE so a battery client need not poll"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/wrist-remote-DESIGN.md` (status line, line 3-5)
- Modify: `README.md` (new section after the `## Logs — /logs` section)

**Interfaces:**
- Consumes: the three implemented features.
- Produces: nothing.

- [ ] **Step 1: Update the spec's status line**

In `docs/wrist-remote-DESIGN.md`, replace:

```markdown
Status: **designed, not built.** The board-side half is specified and ready to implement. The
wrist device itself is undecided, pending one five-minute test (see [Which
device](#which-device-the-part-that-is-still-open)).
```

with:

```markdown
Status: **board side built** (idempotency key, viewer class, `/api/state/stream`; covered by
`test/remote-selftest.mjs`). The wrist device itself is undecided, pending one five-minute test
(see [Which device](#which-device-the-part-that-is-still-open)).
```

- [ ] **Step 2: Document the endpoints in the README**

In `README.md`, after the `## Logs — /logs` section and before `## Deploy on the Pi (systemd)`, insert:

```markdown
## Remote clients — scoring from something other than the tablet

Anything that can speak HTTP can score: the API is native-client friendly, because a request with
no `Origin` header passes the cross-origin guard by design (curl, the selftests and
`deploy-board.sh` all rely on it). One POST is enough — it installs the manual source and lifts the
idle screen on its own.

```bash
# score a point (left), safely retryable
curl -X POST http://<board-ip>:8890/api/action \
  -H 'content-type: application/json' -H 'X-Scorer-Pin: <pin>' \
  -d '{"id":"remote-0001","action":{"type":"point","side":"left","delta":1}}'

# follow the score without polling
curl -N -H 'X-Client-Class: remote' http://<board-ip>:8890/api/state/stream
```

| | |
|---|---|
| `id` on `/api/action` | Optional, `[\w.-]{1,64}`. The same id replays the cached response instead of scoring again — so a client on a flaky radio can retry. Omit it and behaviour is unchanged. A malformed id is ignored, not refused. |
| `X-Client-Class: remote` | Tells the board this client's **reads** are background polling, so they do not count as an operator being present and do not suppress the connect-QR screen. Its **writes** still count. |
| `GET /api/state/stream` | SSE. Opens with the full `/api/status` envelope, then pushes it again on every state change. Keep-alive comment every 20 s. Fall back to polling `/api/status` if it drops. |

Design notes and the seven client-side invariants a remote must implement:
[`docs/wrist-remote-DESIGN.md`](./docs/wrist-remote-DESIGN.md).
```

- [ ] **Step 3: Verify the README renders and the suite is still green**

Run: `npm test`

Expected: all green. (No code changed in this task; this is the guard against a stray edit.)

- [ ] **Step 4: Commit**

```bash
git add README.md docs/wrist-remote-DESIGN.md
git commit -m "Document the remote endpoints for whoever builds the wrist client"
```

---

## Self-Review

**Spec coverage** — every board-side requirement in `docs/wrist-remote-DESIGN.md` maps to a task:

| Spec section | Task |
|---|---|
| Board side 1 — Idempotency key (256 entries, 120 s, `[\w.-]{1,64}`, malformed = absent) | 1 |
| Board side 2 — Viewer class (`X-Client-Class: remote`, GET/HEAD only) | 2 |
| Board side 3 — SSE state stream (opening snapshot, 20 s heartbeat) | 3 |
| Testing — all five listed assertions | 1 (replay, no-id), 2 (viewer read vs write), 3 (opening snapshot, push) |
| Remote contract, client invariants, sport gate, device choice | **Not in this plan** — client-side, and the device is undecided. Correctly deferred. |

One deliberate gap: the spec's test list includes *"`403` and `429` bodies are the shapes clients branch on."* That is already fully covered by `test/control-auth-selftest.mjs:136-143`, which asserts 403 on a wrong PIN, 429 under sustained guessing, and the presence of `Retry-After`. Duplicating it here would add a second place to update. Not re-tested.

**Placeholder scan** — no TBD/TODO, every code step is complete runnable code, no "similar to Task N".

**Type consistency** — `actionId` is the same name in Steps 5's read and write. `replayGet`/`replayPut` signatures match their call sites (`(id, now)` / `(id, body, now)`). `postTo(port, origin)` returns the same shape `post` has in Task 1 and `post2` has in Task 2. `frames[n].state.points_b` matches the `getState()` contract at `src/manualSource.js:110-123`. `sourceManager.on`/`.off` are `EventEmitter` methods — `SourceManager extends EventEmitter` (`src/sourceManager.js:11`) and emits `'state'` (`:37`).
