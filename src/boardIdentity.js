// Which board this is, and what it can do — for /api/status (`board`), so a second board and the
// apps can tell boards apart (gap-07).
//
// Both boards answer at 172.24.1.1 on their own AP (and 192.168.5.1 on the cable), so the address a
// tablet reached says nothing about WHICH board it is talking to. This does:
//
//   board.id        stable: settings.json `boardId` when someone set it on the board (never through
//                   the API — tablets pair against it, so a scorer must not be able to rename it),
//                   else the board's hostname, which provisioning already makes unique per board
//                   (each board is its own tailnet node, and its TLS name comes from it).
//   board.idSource  'settings' | 'hostname'
//   board.label     a name for people ("Court 2"): settings `boardLabel`, else the id.
//   board.caps      sports       the sports this appliance can switch to
//                   panel        { width, height, source } — the panel's pixels, read from the
//                                firmware's own setting.ini [DISPLAY] (both the vendor firmware and
//                                openscore draw at those numbers); 192x64 when there is no such file
//                   renderer     { kind: 'vendor' | 'openscore' | null, version, device } — from the
//                                board's own Init reply, so null until the first handshake
//
// Everything is ADDED beside `board.fontsize`; no existing status field changes.

import fs from 'node:fs'

// A DNS-label-ish id: lower case, digits, hyphens, 1-63 characters, starting with a letter or
// digit. The same rule for the settings field and the hostname it falls back to.
export const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

// A hostname as an id: the first label, lower-cased, anything else turned into '-'. Empty or
// unusable -> 'ledbox', so there is always SOME id (a dev machine called "localhost" still answers).
export function idFromHostname(hostname) {
  const first = String(hostname ?? '').trim().toLowerCase().split('.')[0]
  const id = first.replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').replace(/-+$/, '').slice(0, 63)
  return BOARD_ID_RE.test(id) ? id : 'ledbox'
}

// The panel's size from the firmware's setting.ini, [DISPLAY] width / height. Read once, at start-up
// (the panel does not change under a running board). null when there is no file, no section, or the
// numbers are not sane — the caller then says 'default'.
export function readPanelGeometry(iniPath) {
  let text
  try { text = fs.readFileSync(iniPath, 'utf8') } catch { return null }
  let section = '', width = null, height = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[;#].*$/, '').trim()
    if (!line) continue
    const sec = /^\[([^\]]+)\]$/.exec(line)
    if (sec) { section = sec[1].trim().toUpperCase(); continue }
    if (section !== 'DISPLAY') continue
    const kv = /^([A-Za-z_]+)\s*=\s*(\d+)\s*$/.exec(line)
    if (!kv) continue
    if (kv[1].toLowerCase() === 'width') width = Number(kv[2])
    if (kv[1].toLowerCase() === 'height') height = Number(kv[2])
  }
  const sane = (n) => Number.isInteger(n) && n >= 8 && n <= 4096
  return sane(width) && sane(height) ? { width, height } : null
}

// What renders the panel, from the board's Init reply: openscore names itself in its version
// ("openscore-1.0.0", firmware/openscore build_config); the vendor firmware sends its own number
// ("0.552"). No reply yet -> kind null.
export function rendererOf(info) {
  const version = info && info.version != null && String(info.version).trim() ? String(info.version).trim().slice(0, 40) : null
  const device = info && info.deviceName != null && String(info.deviceName).trim() ? String(info.deviceName).trim().slice(0, 40) : null
  const kind = version ? (/^openscore\b/i.test(version) ? 'openscore' : 'vendor') : null
  return { kind, version, device }
}

// The whole `board` identity block (without fontsize, which the caller keeps adding as before).
export function boardIdentity({ boardId = '', boardLabel = '', hostname = '', sports = [], panel = null, info = null } = {}) {
  const set = String(boardId || '').trim().toLowerCase()
  const fromSettings = BOARD_ID_RE.test(set)
  const id = fromSettings ? set : idFromHostname(hostname)
  const label = String(boardLabel || '').trim() || id
  return {
    id,
    idSource: fromSettings ? 'settings' : 'hostname',
    label,
    caps: {
      sports: [...sports],
      panel: panel ? { width: panel.width, height: panel.height, source: 'setting.ini' } : { width: 192, height: 64, source: 'default' },
      renderer: rendererOf(info),
    },
  }
}
