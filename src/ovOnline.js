// "OpenVolley online for devices on the board's Wi-Fi" — the bridge's side of the switch.
//
// The board's own Wi-Fi has no internet (provisioning/ledbox-firewall.sh, lock-control-network.sh),
// so the OpenVolley Android app on a tablet there can only score against the board itself. To score
// ONLINE (the cloud, wss://backend.openvolley.app) the tablet needs OpenVolley's servers and nothing
// else; provisioning/ledbox-ov-online.sh opens exactly that, as root. The bridge runs as pi and asks
// it through sudo, allowed for exactly `on`, `off` and `status` (setup-ov-online.sh's sudoers file):
// the console switches it (Settings, behind the scorer PIN) and can never widen it.
//
// The helper prints one JSON line of status for every command; this keeps the last one, so
// /api/status (polled every 1.5 s by every open console) never forks — a stale copy is refreshed in
// the background, and GET /api/ovonline asks afresh.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { log } from './logStore.js'

const olog = log.child('ovonline')

export const HELPER = '/usr/local/sbin/ledbox-ov-online'
const TTL_MS = 15_000
const RUN_TIMEOUT_MS = 30_000
// What the helper may say about why it is not active (anything else is dropped, not echoed).
const REASONS = new Set(['no-firewall', 'no-nftset', 'no-uplink-dns', 'not-applied', 'leftover', 'bad-config'])
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

// The console's words for a refusal, so it can show them as they are.
export const REFUSAL = {
  'no-firewall': 'The board\'s firewall is not set up for this (provisioning/install-firewall.sh) — nothing was opened.',
  'no-nftset': 'This board\'s DNS server cannot do this (dnsmasq needs nftset) — nothing was opened.',
  'bad-config': 'The board\'s OpenVolley-online settings are not valid — nothing was opened.',
  'not-installed': 'Not set up on this board (provisioning/setup-ov-online.sh).',
  'no-sudo': 'The board did not let the console switch this (sudo) — run provisioning/setup-ov-online.sh.',
  failed: 'The board could not switch it — see Diagnostics ▸ Logs.',
}

// One status line from the helper, trusted only for its shape.
export function parseStatus(text) {
  const line = String(text || '').trim().split('\n').filter(Boolean).pop() || ''
  let j
  try { j = JSON.parse(line) } catch { return null }
  if (!j || typeof j !== 'object' || j.installed !== true) return null
  const p = j.pieces && typeof j.pieces === 'object' ? j.pieces : {}
  const b = (v) => v === true
  return {
    available: true,
    enabled: b(j.enabled),
    active: b(j.active),
    reason: REASONS.has(j.reason) ? j.reason : null,
    upstream: typeof j.upstream === 'string' && IPV4.test(j.upstream) ? j.upstream : null,
    addresses: Number.isInteger(j.addresses) && j.addresses >= 0 ? j.addresses : 0,
    pieces: { nft: b(p.nft), forward: b(p.forward), nat: b(p.nat), dns: b(p.dns), ipForward: b(p.ipForward) },
  }
}

export class OvOnline {
  // `run(cmd)` resolves { code, stdout, stderr } — injectable so a test never reaches for sudo.
  constructor({ helper = HELPER, sudo = true, run = null, exists = null, ttlMs = TTL_MS, now = () => Date.now() } = {}) {
    this.helper = helper
    this._sudo = sudo
    this._run = run || ((cmd) => this._exec(cmd))
    this._exists = exists || (() => { try { fs.accessSync(this.helper, fs.constants.X_OK); return true } catch { return false } })
    this.ttlMs = ttlMs
    this.now = now
    this._last = null       // the newest parsed status, with checkedAt
    this._inflight = null   // a status/on/off in flight; the next caller waits for it
    this._error = null
    this._triedAt = -Infinity // the last time the helper was asked, answer or not
  }

  _exec(cmd) {
    const [file, args] = this._sudo ? ['sudo', ['-n', this.helper, cmd]] : [this.helper, [cmd]]
    return new Promise((resolve) => {
      execFile(file, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
      })
    })
  }

  // What the console shows: { available, enabled, active, reason, upstream, addresses, checkedAt }.
  // From the last answer; kicks off a fresh one in the background when it is stale.
  view() {
    if (!this._exists()) return { available: false, enabled: false, active: false, reason: 'not-installed', checkedAt: null }
    // Stale (or never answered): ask again, but never more than once per ttl — a broken sudo must not
    // fork on every /api/status poll.
    if (!this._inflight && this.now() - this._triedAt > this.ttlMs) this.refresh().catch(() => {})
    if (!this._last) return { available: true, enabled: false, active: false, reason: this._error, checking: true, checkedAt: null }
    const { pieces, ...v } = this._last
    return { ...v, ...(this._error ? { error: this._error } : {}) }
  }

  // The whole answer, pieces included (GET /api/ovonline).
  detail() { return this._last ? { ...this._last } : this.view() }

  async refresh() { return this._call('status') }

  // Turn it on or off. Resolves { ok, reason, view }: ok false with a reason the console has words
  // for (REFUSAL) when the helper refused or could not be run.
  async set(on) {
    if (!this._exists()) return { ok: false, reason: 'not-installed', view: this.view() }
    const r = await this._call(on ? 'on' : 'off')
    const v = this.view()
    if (r.ok && (!on || v.enabled)) return { ok: true, reason: on && !v.active ? v.reason : null, view: v }
    return { ok: false, reason: r.reason || v.reason || 'failed', view: v }
  }

  async _call(cmd) {
    // One at a time: a status poll racing an `on` must not land after it with the old answer.
    while (this._inflight) await this._inflight.catch(() => {})
    this._triedAt = this.now()
    const p = (async () => {
      let r
      try { r = await this._run(cmd) } catch (e) { r = { code: 1, stdout: '', stderr: String((e && e.message) || e) } }
      const st = parseStatus(r.stdout)
      if (st) {
        this._last = { ...st, checkedAt: this.now() }
        this._error = null
      }
      if (r.code === 0 && st) return { ok: true }
      // sudo -n with no rule for us: "a password is required", or the helper not allowed.
      if (!st && /password is required|not allowed|may not run/i.test(r.stderr)) {
        this._error = 'no-sudo'
        olog.warn(`could not run ${this.helper} ${cmd}: sudo refused (provisioning/setup-ov-online.sh installs the rule)`, { cmd })
        return { ok: false, reason: 'no-sudo' }
      }
      if (st) {
        // The helper's refusals (3: no forward drop, 4: dnsmasq without nftset) carry the status.
        const reason = r.code === 4 ? 'no-nftset' : r.code === 3 ? (st.reason === 'bad-config' ? 'bad-config' : 'no-firewall') : 'failed'
        olog.warn(`${this.helper} ${cmd} refused (exit ${r.code}, ${reason})`, { cmd, code: r.code, reason })
        return { ok: false, reason }
      }
      this._error = 'failed'
      olog.warn(`${this.helper} ${cmd} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`, { cmd, code: r.code })
      return { ok: false, reason: 'failed' }
    })()
    this._inflight = p
    try { return await p } finally { if (this._inflight === p) this._inflight = null }
  }
}
