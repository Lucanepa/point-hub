// Following an OpenVolley match by its scoreboard code (openvolley escoresheet/docs/scoreboard-code-spec.md
// and scoreboard-feed.md).
//
// The scorer opens Match ▸ Show on a scoreboard and gets a short read-only code, `ABCD-2345`. A board
// that knows it finds the match on the relay its scorer uses — OpenVolley's cloud from ANY network, or a
// relay in the hall — and gets the PIN-free public live state only:
//   -> { type: 'subscribe-match', code, device: 'display', settingsUrl? }
//   <- { type: 'display-code', ok: true, matchId, endsAt }            then the usual summary / live updates
//   <- { type: 'display-code', ok: false, reason: 'not-found' | 'rate-limited', retryAfter? }
//   <- { type: 'display-code', ok: false, reason: 'ended', matchId? }  the code ended: no more updates
// or over HTTP, POST /api/display/lookup { code } -> 200 { ok, matchId, endsAt } | 404 | 410 | 429.
//
// The code is 8 symbols of ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (no 0/O/1/I); a relay compares it upper-
// cased with spaces and dashes removed. It is never logged here either: a log line names it by its
// `ref`, the first 8 hex of sha256("d:" + code) — the same ref OpenVolley's relays log, so the two logs
// can be matched up. On disk only while it is followed (FollowCodeStore: 0600, cleared on unlink/end).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LEN = 8
// A code lives at most 12 hours (OpenVolley's MAX_LIFE_MS).
export const CODE_MAX_LIFE_MS = 12 * 60 * 60 * 1000

// The code as a relay compares it, or null when it cannot be one.
export function normalizeCode(value) {
  if (typeof value !== 'string' || value.length > 64) return null
  const s = value.toUpperCase().replace(/[\s-]/g, '')
  return s.length === CODE_LEN && [...s].every((c) => CODE_ALPHABET.includes(c)) ? s : null
}

// `ABCD-2345`, as the scorer's screen shows it. null for anything that is not a code.
export function formatCode(value) {
  const c = normalizeCode(value)
  return c ? `${c.slice(0, 4)}-${c.slice(4)}` : null
}

// The code in whatever the operator pasted or a scanner typed: the code itself (any case, spaces,
// dashes), or the board page's address from the scorer's QR code — `https://livescore.openvolley.app/board#ABCD2345`,
// `http://<relay>:5173/livescore/board#ABCD-2345`, also `?code=ABCD2345`. null when there is none.
export function extractCode(input) {
  if (typeof input !== 'string') return null
  const raw = input.trim().slice(0, 500)
  if (!raw) return null
  const direct = normalizeCode(raw)
  if (direct) return direct
  let u = null
  if (/^https?:\/\//i.test(raw)) { try { u = new URL(raw) } catch { u = null } }
  else if (/^[\w.-]+(:\d+)?\/\S*$/.test(raw)) { try { u = new URL(`http://${raw}`) } catch { u = null } }
  if (u) {
    const frag = decodeURIComponent(u.hash.replace(/^#/, ''))
    const fromFrag = normalizeCode(frag.replace(/^code=/i, ''))
    if (fromFrag) return fromFrag
    const q = u.searchParams.get('code')
    const fromQuery = q && normalizeCode(q)
    if (fromQuery) return fromQuery
    return null
  }
  // "Code: ABCD-2345" and the like: one 8-symbol group, nothing else that could be one.
  const words = raw.split(/[^A-Za-z0-9-]+/).filter(Boolean).slice(0, 40)
  const candidates = [...words, ...words.slice(1).map((w, i) => words[i] + w)]
  const codes = [...new Set(candidates.map(normalizeCode).filter(Boolean))]
  return codes.length === 1 ? codes[0] : null
}

// The code's name in a log line: 8 hex of sha256("d:" + code), as OpenVolley's relays log it.
export function codeRef(code) {
  const c = normalizeCode(code)
  return c ? crypto.createHash('sha256').update(`d:${c}`).digest('hex').slice(0, 8) : null
}

// Where a code is looked up: OpenVolley's cloud (the default), the board's own OpenVolley, or a scorer
// laptop's relay in the hall.
export const CODE_RELAYS = Object.freeze(['cloud', 'board', 'laptop'])

// The code being followed, kept for a reconnect and a bridge restart until it ends. One small file in
// the board's state directory, 0600 (it is read-only access to one match, but nobody else on the box
// needs it), written atomically, removed on unlink and when the code ends. Never logged.
//   { code, relay: 'cloud'|'board'|'laptop', wsUrl, savedAt, endsAt, confirmed }
export class FollowCodeStore {
  constructor({ file } = {}) {
    this.file = file || null
  }

  get() {
    if (!this.file) return null
    let v
    try { v = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { return null }
    const code = v && normalizeCode(v.code)
    if (!code || !CODE_RELAYS.includes(v.relay) || typeof v.wsUrl !== 'string' || !/^wss?:\/\//i.test(v.wsUrl)) return null
    return {
      code, relay: v.relay, wsUrl: v.wsUrl.slice(0, 300),
      savedAt: Number(v.savedAt) || 0,
      endsAt: Number.isFinite(Number(v.endsAt)) && Number(v.endsAt) > 0 ? Number(v.endsAt) : null,
      confirmed: v.confirmed === true,
    }
  }

  save(entry) {
    if (!this.file) return false
    const code = normalizeCode(entry && entry.code)
    if (!code) return false
    const v = {
      code, relay: entry.relay, wsUrl: entry.wsUrl,
      savedAt: Number(entry.savedAt) || Date.now(),
      endsAt: entry.endsAt != null && Number(entry.endsAt) > 0 ? Number(entry.endsAt) : null,
      confirmed: entry.confirmed === true,
    }
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 })
      fs.chmodSync(tmp, 0o600)
      fs.renameSync(tmp, this.file)
      return true
    } catch {
      try { fs.rmSync(tmp, { force: true }) } catch { /* gone */ }
      return false
    }
  }

  update(patch) {
    const cur = this.get()
    return cur ? this.save({ ...cur, ...patch }) : false
  }

  clear() {
    if (!this.file) return
    try { fs.rmSync(this.file, { force: true }) } catch { /* gone */ }
  }
}
