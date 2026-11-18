// How the board announces itself to the OpenVolley relay it follows (docs/board-settings-from-openvolley.md).
//
// OpenVolley's relays take an optional label on the subscription: a scoreboard display says
//   { type: 'subscribe-match', matchId, device: 'display', settingsUrl }
// and the relay tells the match's scorer, and only the scorer, that a display follows and where its
// settings page is (display-presence). The scorer's menu then offers "Scoreboard settings", which opens
// that page: this board's console, Settings tab (`/#settings`, which the console opens on load and the
// scorer PIN guards as always). OpenVolley stays brand-free: it never learns this is a Point Hub.
//
// The page is the console's address on the board's own Wi-Fi (the AP, 172.24.1.1) on its HTTP port:
// where every tablet that scores against the board is. The relays pass it on only when it is an http(s)
// URL on a private-LAN address, so anything else here (a name, a public address) is simply dropped.
//
// Nothing is announced until the appliance configures it (setBoardAnnouncement): the headless bridge
// and the selftests subscribe exactly as before. BOARD_SETTINGS_URL overrides the page; "off" announces
// the display without one (the scorer then gets no menu entry).

export const DISPLAY_DEVICE = 'display'
export const BOARD_AP_HOST = '172.24.1.1'

let current = null

// The console's Settings tab on the board's own Wi-Fi.
export function boardSettingsUrl({ host = BOARD_AP_HOST, port = 8890 } = {}) {
  const p = Number(port)
  return `http://${host}${p && p !== 80 ? `:${p}` : ''}/#settings`
}

// The announcement the appliance makes: from the environment, else the console's AP address.
export function boardAnnouncementFromEnv(env = process.env, { controlPort = 8890 } = {}) {
  const raw = String(env.BOARD_SETTINGS_URL ?? '').trim()
  if (/^(0|off|false|no|none)$/i.test(raw)) return { settingsUrl: null }
  return { settingsUrl: raw || boardSettingsUrl({ port: controlPort }) }
}

export function setBoardAnnouncement(a) {
  current = a ? { settingsUrl: typeof a.settingsUrl === 'string' && a.settingsUrl ? a.settingsUrl : null } : null
}

export function boardAnnouncement() {
  return current
}

// The fields a subscribe-match carries for this announcement ({} for none).
export function announcementFields(a = current) {
  if (!a) return {}
  return a.settingsUrl ? { device: DISPLAY_DEVICE, settingsUrl: a.settingsUrl } : { device: DISPLAY_DEVICE }
}
