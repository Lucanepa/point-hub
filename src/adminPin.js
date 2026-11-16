// The board's Admin PIN: separate from the scorer PIN, kept as a scrypt hash in a private file
// ("<state>/admin-pin", written by provisioning/point-hub/set-admin-pin), never in the repo or in
// Settings. Only the board's own screen can ask (controlServer checks that first). Wrong guesses
// lock the pad for a growing time, the same idea as the scorer PIN's lockout.
import fs from 'node:fs'
import { scryptSync, timingSafeEqual, randomBytes } from 'node:crypto'

export const ADMIN_PIN_RE = /^\d{4,12}$/

export function hashAdminPin(pin) {
  const salt = randomBytes(16)
  const key = scryptSync(String(pin), salt, 32)
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
}

export function makeAdminPin(file, { now = Date.now, maxFree = 4, baseLockMs = 30_000, maxLockMs = 15 * 60_000 } = {}) {
  let fails = 0
  let lockedUntil = 0
  const read = () => {
    try {
      const [kind, saltHex, keyHex] = fs.readFileSync(file, 'utf8').trim().split('$')
      if (kind !== 'scrypt' || !saltHex || !keyHex) return null
      return { salt: Buffer.from(saltHex, 'hex'), key: Buffer.from(keyHex, 'hex') }
    } catch { return null }
  }
  return {
    isSet: () => !!read(),
    // { ok } | { ok: false, locked, retryAfterMs } | { ok: false, unset }
    check(pin) {
      const t = now()
      if (t < lockedUntil) return { ok: false, locked: true, retryAfterMs: lockedUntil - t }
      const rec = read()
      if (!rec) return { ok: false, unset: true }
      const given = scryptSync(String(pin ?? ''), rec.salt, rec.key.length)
      if (timingSafeEqual(given, rec.key)) { fails = 0; return { ok: true } }
      fails += 1
      if (fails > maxFree) {
        const ms = Math.min(maxLockMs, baseLockMs * 2 ** (fails - maxFree - 1))
        lockedUntil = t + ms
        return { ok: false, locked: true, retryAfterMs: ms }
      }
      return { ok: false }
    },
  }
}
