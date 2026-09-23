// Operator settings for the appliance — persisted to disk so a venue's preferences survive a
// restart (and a power cut mid-tournament).
//
// PER-SPORT vs GLOBAL. Each sport (volleyball/beach/basketball/simple) carries its OWN timing, allowances
// and format — beach runs 1' breaks and best-of-3, indoor runs 30s and best-of-5 — while
// brightness, club name, PIN, the active sport, branding and live-scoring are shared (GLOBAL).
//
//   on disk:   { <global keys…>, perSport: { volleyball:{…}, beach:{…}, basketball:{…} } }
//   in memory: `settings.values` is a FLAT view = the global keys merged with the ACTIVE sport's
//              per-sport keys. Consumers keep reading `settings.values.timeoutSeconds` etc.
//              unchanged; the active sport is fixed at boot (changing it restarts the appliance).
//              `forSport(key)` returns the same flat view for any sport.
//
// The old FLAT settings.json (all keys top-level, pre-multisport) migrates on load into
// perSport.volleyball with every value preserved — a migrated board behaves byte-for-byte as before.

import fs from 'node:fs'
import path from 'node:path'
import { log } from './logStore.js'

const setlog = log.child('settings')

const SPORTS = ['volleyball', 'beach', 'basketball', 'simple']
const BRANDINGS = ['kscw', 'plain']
const LIVE_SYSTEMS = ['off', 'kscw']
const ORIENTATIONS = ['behind', 'front']

// Shared across every sport.
export const GLOBAL_DEFAULTS = {
  // Panel LED brightness (rpi-rgb-led-matrix --led-brightness, clamped 0-100). 0 = panel OFF.
  brightness: 40,
  // Idle (crest) screen: full club name vs short code, and the largest font it may use.
  // The IN-MATCH name size is a separate, per-sport key (`matchFontMax`) — the crest has a
  // 125px name column, the scoreboard only ~86px, so one number cannot serve both.
  idleFullNames: true,
  idleFontMax: 24,
  // Shown on the set-interval and warm-up countdowns. Short — it lands in a narrow label box.
  clubName: 'KSC WIEDIKON',
  // Scorer PIN. Set = the board rejects scoring/control without it. Empty = open. Digits, max 8.
  scorerPin: '',
  // Active sport — selects the Source, layout and mapper at boot (src/sports.js). A change restarts.
  sport: 'volleyball',
  // Idle-screen crest identity: 'kscw' (KSC Wiedikon) | 'plain' (no logo).
  branding: 'kscw',
  // Live-scoring publish target: 'off' | 'kscw' (Directus → wiedisync /live; see livePush).
  liveScoring: 'off',
  // Where the scorer sits: 'behind' the panel (the usual table, facing the court with the board at
  // their back — their left is the panel's right) or 'front' (facing the panel, sides 1:1). Only the
  // console reads it, to put each team card on the scorer's own side; the server, the sources and
  // the mappers keep PANEL sides whatever it says. Shared like branding: it is about the hall.
  orientation: 'behind',
}

// Per-sport. Volleyball = the historical flat values (so a migrated board is identical). Beach =
// FIVB with the club's 1' breaks + technical timeout. Basketball = FIBA-ish (fouls reuse `totalSubs`).
export const PER_SPORT_DEFAULTS = {
  volleyball: {
    blinkPoint: true, blinkSub: true, blinkMs: 2000,
    timeoutSeconds: 30, ttoSeconds: 0, setIntervalSeconds: 180, warmupSeconds: 600,
    countdownOnTimeout: true, countdownOnSetInterval: true, hornOnCountdownEnd: true,
    totalTimeouts: 2, totalSubs: 6, bestOf: 5, matchFontMaxLeft: 18, matchFontMaxRight: 18,
  },
  beach: {
    blinkPoint: true, blinkSub: false, blinkMs: 2000,
    timeoutSeconds: 60, ttoSeconds: 60, setIntervalSeconds: 60, warmupSeconds: 600,
    countdownOnTimeout: true, countdownOnSetInterval: true, hornOnCountdownEnd: true,
    totalTimeouts: 1, totalSubs: 0, bestOf: 3, matchFontMaxLeft: 18, matchFontMaxRight: 18,
  },
  basketball: {
    blinkPoint: true, blinkSub: true, blinkMs: 2000,
    timeoutSeconds: 60, ttoSeconds: 0, setIntervalSeconds: 120, warmupSeconds: 600,
    countdownOnTimeout: true, countdownOnSetInterval: true, hornOnCountdownEnd: true,
    totalTimeouts: 5, totalSubs: 5, bestOf: 3, matchFontMaxLeft: 18, matchFontMaxRight: 18,
  },
  // Simple scoreboard. It has no sets, timeouts, subs or set intervals, so most of these keys
  // describe nothing — but every sport must carry the full PER_SPORT_KEYS set (the sanitizer
  // walks one key list for all of them), so they are present and inert. blinkSub is off because
  // there are no substitutions to blink; the countdown/warm-up values stay usable because the
  // warm-up clock is a plain timer and works here exactly as it does everywhere else.
  simple: {
    blinkPoint: true, blinkSub: false, blinkMs: 2000,
    timeoutSeconds: 60, ttoSeconds: 0, setIntervalSeconds: 60, warmupSeconds: 600,
    countdownOnTimeout: false, countdownOnSetInterval: false, hornOnCountdownEnd: true,
    // These three take the LOWEST value their own sanitizers accept rather than the honest 0/1:
    // totalTimeouts clamps to [1,9] and bestOf coerces anything but 3 to 5, so a truthful 0 or 1
    // here would silently become 1 and 5 on the first save — a stored default that disagrees with
    // the file it came from. Inert either way; this sport reads none of them.
    totalTimeouts: 1, totalSubs: 0, bestOf: 3, matchFontMaxLeft: 18, matchFontMaxRight: 18,
  },
}

export const GLOBAL_KEYS = Object.keys(GLOBAL_DEFAULTS)
export const PER_SPORT_KEYS = Object.keys(PER_SPORT_DEFAULTS.volleyball)
// Back-compat flat default view (global + volleyball) for anything that still imports DEFAULTS.
export const DEFAULTS = { ...GLOBAL_DEFAULTS, ...PER_SPORT_DEFAULTS.volleyball }

// A scorer PIN: digits only, 1-8 of them. The ONE rule — the server's 400 on POST /api/settings and
// the console's check before it sends both test against this, so the three can never disagree
// about what a valid PIN is.
export const PIN_RE = /^\d{1,8}$/

const BOOLS = ['blinkPoint', 'blinkSub', 'countdownOnTimeout', 'countdownOnSetInterval', 'hornOnCountdownEnd', 'idleFullNames']
const NUMS = {
  idleFontMax: [10, 30], matchFontMaxLeft: [10, 30], matchFontMaxRight: [10, 30],
  brightness: [0, 100], blinkMs: [200, 10000],
  timeoutSeconds: [5, 600], ttoSeconds: [0, 600], setIntervalSeconds: [10, 1800], warmupSeconds: [10, 3600],
  totalTimeouts: [1, 9], totalSubs: [0, 15],
}

// Coerce + clamp the given `keys` from `patch` INTO `out` (mutates + returns it). A bad value is
// dropped (out keeps its prior value), so a typo can never wedge the board.
function sanitizeInto(out, keys, patch = {}) {
  for (const k of keys) {
    if (!(k in patch)) continue
    if (BOOLS.includes(k)) { out[k] = !!patch[k]; continue }
    if (k in NUMS) {
      const n = Number(patch[k])
      if (Number.isFinite(n)) { const [lo, hi] = NUMS[k]; out[k] = Math.min(hi, Math.max(lo, Math.round(n))) }
      continue
    }
    if (k === 'bestOf') { out[k] = Number(patch[k]) === 3 ? 3 : 5; continue }
    if (k === 'clubName') { out[k] = String(patch[k] || '').replace(/[^\x20-\x7E]/g, '').slice(0, 20); continue }
    // Accepted as typed or not at all. This used to strip every non-digit and keep the rest, so
    // "abcd" or " " became "" — which is not a malformed PIN but NO PIN, and the scorer lock came
    // off under a "Saved.". A malformed value is dropped like any other bad value here (the prior
    // PIN stands); POST /api/settings rejects it with a 400 before it gets this far, and removing
    // the lock is its own explicit request (`clearPin`), never a side effect of a typo.
    if (k === 'scorerPin') {
      const pin = String(patch[k] ?? '').trim()
      if (pin === '' || PIN_RE.test(pin)) out[k] = pin
      else setlog.warn('ignored a malformed scorer PIN — the previous one stays in force', { rule: 'digits only, 1-8' })
      continue
    }
    if (k === 'sport') { out[k] = SPORTS.includes(String(patch[k])) ? String(patch[k]) : out[k]; continue }
    if (k === 'branding') { out[k] = BRANDINGS.includes(String(patch[k])) ? String(patch[k]) : out[k]; continue }
    if (k === 'liveScoring') { out[k] = LIVE_SYSTEMS.includes(String(patch[k])) ? String(patch[k]) : out[k]; continue }
    if (k === 'orientation') { out[k] = ORIENTATIONS.includes(String(patch[k])) ? String(patch[k]) : out[k]; continue }
  }
  return out
}

// Back-compat flat sanitizer (both global + per-sport keys against one flat base).
export function sanitize(patch = {}, base = DEFAULTS) {
  return sanitizeInto({ ...base }, [...GLOBAL_KEYS, ...PER_SPORT_KEYS], patch)
}

// Build the clean on-disk structure from ANYTHING on disk — the new shape, the OLD FLAT shape, or
// junk. Old flat = a volleyball-only board, so its per-sport keys migrate into perSport.volleyball.
function normalize(input) {
  const raw = (input && typeof input === 'object') ? input : {}
  const hasPerSport = raw.perSport && typeof raw.perSport === 'object'
  const out = sanitizeInto({ ...GLOBAL_DEFAULTS }, GLOBAL_KEYS, raw)
  out.perSport = {}
  for (const sp of SPORTS) {
    const src = hasPerSport ? (raw.perSport[sp] || {}) : (sp === 'volleyball' ? raw : {})
    // `matchFontMax` was briefly a single ceiling for both names before it became one per side.
    // Seed both sides from it so a board written by that version keeps the size it was set to
    // instead of silently snapping back to the default.
    const seeded = (src && src.matchFontMax != null && src.matchFontMaxLeft == null && src.matchFontMaxRight == null)
      ? { ...src, matchFontMaxLeft: src.matchFontMax, matchFontMaxRight: src.matchFontMax }
      : src
    out.perSport[sp] = sanitizeInto({ ...PER_SPORT_DEFAULTS[sp] }, PER_SPORT_KEYS, seeded)
  }
  return out
}

// The flat view a consumer reads: global keys + the given sport's per-sport keys.
function flatten(raw, sport) {
  const sp = SPORTS.includes(sport) ? sport : 'volleyball'
  const out = {}
  for (const k of GLOBAL_KEYS) out[k] = raw[k]
  return Object.assign(out, raw.perSport[sp])
}

export class Settings {
  constructor(file) {
    this.file = file
    this.raw = normalize(null)
    this.values = flatten(this.raw, this.raw.sport)
    this.load()
  }

  load() {
    let migrated = false
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      migrated = !(parsed && parsed.perSport) // an old flat file gets rewritten in the new shape once
      this.raw = normalize(parsed)
      setlog.debug('loaded from disk', { file: this.file, migrated })
    } catch (err) {
      // Falling back to defaults is deliberate (never crash at boot) but it silently discards
      // a venue's preferences — worth a warning, and worth knowing WHICH of the two it was.
      const missing = err && err.code === 'ENOENT'
      setlog[missing ? 'info' : 'warn'](
        missing ? 'no settings file yet — using defaults' : `settings file unreadable (${err && err.message}) — using defaults`,
        { file: this.file, error: missing ? undefined : String(err && err.message) },
      )
      this.raw = normalize(null) // missing or corrupt: defaults, never a crash at boot (and no write)
    }
    this.values = flatten(this.raw, this.raw.sport)
    if (migrated) {
      setlog.info('migrated the old flat settings file into the per-sport shape', { file: this.file })
      this.save() // persist the migrated shape a single time
    }
    return this.values
  }

  // Route a flat patch: global keys → top level, per-sport keys → the ACTIVE sport. Returns the
  // fresh flat view.
  //
  // `sport` is deliberately NOT reachable from a generic patch. Switching sport has to come with
  // the .sport-switch marker and the restart that rebuild the source, layout and mapper; a patch
  // that only moved the key on disk left the console reshaped to the new sport while the engine
  // kept the old one (basketball +2/+3 buttons driving a volleyball score). Only the caller that
  // owns those side-effects — POST /api/sport — passes { allowSport: true }.
  update(patch = {}, { allowSport = false } = {}) {
    // Resolve the target sport BEFORE the patch can change it. A form is always rendered under
    // the sport that was active when it loaded, so its per-sport values belong to THAT sport.
    // Reading raw.sport after applying the patch would route the outgoing sport's numbers into
    // the incoming one and silently overwrite its defaults on disk.
    const active = SPORTS.includes(this.raw.sport) ? this.raw.sport : 'volleyball'
    sanitizeInto(this.raw, allowSport ? GLOBAL_KEYS : GLOBAL_KEYS.filter((k) => k !== 'sport'), patch)
    sanitizeInto(this.raw.perSport[active], PER_SPORT_KEYS, patch)
    this.save()
    this.values = flatten(this.raw, this.raw.sport)
    return this.values
  }

  // Flat view for any sport (global + that sport's per-sport) without changing the active sport.
  forSport(sport) {
    return flatten(this.raw, sport)
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // Write-then-rename: a power cut mid-write leaves the old file intact rather than a
      // truncated one that would silently reset every preference.
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.raw, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      // The operator saw "saved" in the UI; if the write failed they must be able to find out.
      setlog.error(`could not save: ${err.message}`, { file: this.file, error: err.message })
    }
  }
}

// Sets needed to win, whether this is the short deciding set, and that set's point target. THE
// single place the format numbers come from: the scoring sources call this rather than carrying
// their own constants, because the console header already derives "Final" from `bestOf` and the
// two used to disagree — a best-of-3 read Final at 2 sets while the engine still wanted 3.
// `targets` lets a sport with different numbers reuse the same set arithmetic (beach: 21/15).
export function formatRules(bestOf, setsA, setsB, targets = {}) {
  const toWin = Number(bestOf) === 3 ? 2 : 3
  const deciding = setsA === toWin - 1 && setsB === toWin - 1
  const normalTarget = targets.normal ?? 25
  const decidingTarget = targets.deciding ?? 15
  return { toWin, deciding, target: deciding ? decidingTarget : normalTarget }
}
