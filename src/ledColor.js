// What a team colour does ON THE GLASS, and the floor that keeps every team visible there.
//
// The bridge sends the operator's exact team colour (hexToRgb), and the panel driver does not
// show it linearly. flushBuffer2 is hzeller's rpi-rgb-led-matrix with luminance correction on:
// each 0-255 channel is mapped through CIE 1931 lightness at the configured brightness into an
// 11-bit value (lib/framebuffer.cc luminance_cie1931, kBitPlanes = 11), and with pwm_bits = 7
// only the top 7 of those bit planes are shown (start_bit = 11 - pwm_bits), so the low 4 bits
// are simply dropped. At the hall's brightness 40, full white drives 230/2047 (about 11 %
// luminance), which is 14 PWM levels. Everything a colour has is somewhere in those 14 steps:
//
//   #ffffff  14/14/14     #ef4444  12/1/1     #2563eb  0/2/12     #111827  0/0/0  <- dark
//
// That last one is the console's own preset for black or navy shirts. Sent as it is, that team's
// name, score, set count and box border are not dim on the panel, they are OFF. "The board keeps
// the exact shirt colour" cannot hold for a colour the LEDs cannot light, so this file decides,
// per section, what the panel gets instead:
//
//   * a DARK team colour (brightest channel under a few PWM levels at the current brightness)
//     paints its text and digits light grey, and its box border and serve bar in the same hue
//     scaled up until the LEDs light it;
//   * team-coloured SMALL text (names, set counts, the vendor countdown's numbers; 26 px and
//     under) is lifted towards white just far enough to give the light of pure red, which is
//     the dimmest colour anyone already reads without trouble. Blues are the ones it touches;
//   * big digits and borders in a colour the panel can show keep that exact colour.
//
// It runs where the bridge hands sections to the panel (LedboxClient.sendSections and the blink),
// never in the mappers: the console's mirror is built from the mapper output and keeps showing
// the colours the operator chose. Both renderers get it, because it acts on what goes down the
// wire. Pure functions, no state: test/led-color-selftest.mjs drives all of it.

// hzeller lib/framebuffer-internal.h. The CIE value is 11 bits wide whatever pwm_bits says.
export const BIT_PLANES = 11
// setting.ini pwm_bits on the C0270 (firmware/setting.ini.example, firmware/openscore/setting.ini).
// A constant rather than read at run time: it describes the physical panel and changes only when
// someone retunes the board's setting.ini by hand.
export const PANEL_PWM_BITS = 7
// Text at or under this many px counts as small. The match layout's names are 18 and its set
// counts 26; the score digits are 55. The vendor countdown draws its scores at 22, so there they
// are small too, which is what they look like on the glass.
export const SMALL_TEXT_PX = 26
// "A few PWM levels": a colour whose brightest channel drives fewer than this is dark on the
// glass. Never more than a fifth of what white gets, so a dimmed panel (white is 3 levels at
// brightness 20) does not call every colour dark.
export const DARK_LEVELS = 3
// Small team-coloured text must give at least this share of white's light (Rec. 709 weights over
// the driven levels). Pure red gives 0.21 and #ef4444 0.24, and nobody struggles with those.
export const SMALL_TEXT_LUMA = 0.2
// What a dark team's text and digits become. Light grey rather than white, so a dark team and a
// white team still differ a little, and the white labels stay the brightest thing on the panel.
export const DARK_INK = '220,220,220'
// A dark team's border and serve bar keep the hue, scaled until the brightest channel is this:
// #111827 becomes 70,98,160, which drives 1/2/5 at brightness 40 instead of nothing.
export const EDGE_LIFT = 160
// The mappers' own "off" for a border or a serve bar (box() in the warm-up, the simple
// scoreboard's invisible boxes, SERVE_OFF). These are meant to be dark and are never lifted. A
// team in exactly #000000 therefore keeps a black border; its digits still go light grey.
export const PANEL_OFF = new Set(['0,0,0', '30,30,30'])

// Default text size per layout for the sections that carry a team colour, from layouts/*.xml
// and firmware/openscore/layout*/ (the selftest checks this table against them). A fontsize in
// the same SetSections write wins; anything not listed falls back to TEXT_PX_FALLBACK.
export const LAYOUT_TEXT_PX = {
  volleyball_matchscore_02: { team1: 18, team2: 18, score1: 55, score2: 55, set1: 26, set2: 26, sub1: 18, sub2: 18 },
  volleyball_matchscore_timeout_02: { score1: 22, score2: 22, set1: 14, set2: 14 },
  openvolley_timeout: { score1: 22, score2: 22, set1: 14, set2: 14 },
  kscw_break: { team: 15, score1: 55, score2: 55, set1: 16, set2: 16 },
  kscw_idle: { team1: 24, team2: 24 },
  kscw_result: { winner: 17 },
  beach_matchscore: { team1: 18, team2: 18, score1: 55, score2: 55, set1: 20, set2: 20, serveplr1: 38, serveplr2: 38 },
  beach_idle: { team1: 22, team2: 22 },
  basketball_matchscore: { team1: 18, team2: 18, score1: 55, score2: 55 },
  basketball_idle: { team1: 22, team2: 22 },
}
const TEXT_PX_FALLBACK = { score1: 55, score2: 55, serveplr1: 38, serveplr2: 38 }
const TEXT_PX_DEFAULT = 18

// Which (section, attribute) pairs carry a team colour. Counters (timeouts, subs, fouls) carry
// limit colours and labels carry white, so neither is ever touched here.
const TEXT_SLOTS = new Set(['team1', 'team2', 'team', 'score1', 'score2', 'set1', 'set2', 'serveplr1', 'serveplr2', 'winner'])
const EDGE_SLOTS = { bordercolor: new Set(['bg_score1', 'bg_score2']), color: new Set(['serve1', 'serve2']) }

// hzeller's luminance_cie1931: channel c (0-255) at brightness 1-100 -> 0..2047.
export function cie1931(c, brightness) {
  const v = (c * brightness) / 255 // CIE L*, 0..100
  const y = v <= 8 ? v / 902.3 : ((v + 16) / 116) ** 3
  return Math.round(((1 << BIT_PLANES) - 1) * y)
}

const clampBrightness = (b) => Math.min(100, Math.max(1, Math.round(Number(b))))

// The PWM level a channel actually drives: the CIE value with the planes below
// BIT_PLANES - pwmBits cut off, exactly as the driver never shows them.
export function channelLevel(c, brightness, pwmBits = PANEL_PWM_BITS) {
  return cie1931(c, clampBrightness(brightness)) >> (BIT_PLANES - pwmBits)
}

export function panelLevels(rgb, brightness, pwmBits = PANEL_PWM_BITS) {
  return rgb.map((c) => channelLevel(c, brightness, pwmBits))
}

export function whiteLevel(brightness, pwmBits = PANEL_PWM_BITS) {
  return channelLevel(255, brightness, pwmBits)
}

// Fewer levels than this in the brightest channel = dark on the glass.
export function darkFloor(brightness, pwmBits = PANEL_PWM_BITS) {
  return Math.min(DARK_LEVELS, Math.max(1, Math.round(whiteLevel(brightness, pwmBits) / 5)))
}

export function isDark(rgb, brightness, pwmBits = PANEL_PWM_BITS) {
  return Math.max(...panelLevels(rgb, brightness, pwmBits)) < darkFloor(brightness, pwmBits)
}

// Light the colour gives on the panel, as a share of white's at the same brightness.
export function panelLuma(rgb, brightness, pwmBits = PANEL_PWM_BITS) {
  const [r, g, b] = panelLevels(rgb, brightness, pwmBits)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / Math.max(1, whiteLevel(brightness, pwmBits))
}

// "r,g,b" (the LedBox colour format, spaces allowed) -> [r, g, b], or null.
export function parseRgb(value) {
  const m = String(value ?? '').match(/^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$/)
  if (!m) return null
  const rgb = [Number(m[1]), Number(m[2]), Number(m[3])]
  return rgb.every((c) => c <= 255) ? rgb : null
}
const fmt = (rgb) => rgb.join(',')
const towardsWhite = (rgb, t) => rgb.map((c) => Math.round(c + (255 - c) * t))

// A team colour used as TEXT of `px` pixels: light grey when dark, lifted when small and dim,
// otherwise exactly as sent. Anything that is not an "r,g,b" string passes through untouched.
export function textColor(value, px, { brightness, pwmBits = PANEL_PWM_BITS } = {}) {
  const rgb = parseRgb(value)
  if (!rgb || !(Number(brightness) > 0)) return value
  if (isDark(rgb, brightness, pwmBits)) return DARK_INK
  if (!(px <= SMALL_TEXT_PX)) return value
  // Same 5 % steps as the console's teamText, and the first step that reads wins.
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const c = towardsWhite(rgb, t)
    if (panelLuma(c, brightness, pwmBits) >= SMALL_TEXT_LUMA) return t === 0 ? value : fmt(c)
  }
  return '255,255,255'
}

// A team colour used as a BORDER or serve bar: the same hue, scaled up only when dark.
export function edgeColor(value, { brightness, pwmBits = PANEL_PWM_BITS } = {}) {
  const rgb = parseRgb(value)
  if (!rgb || !(Number(brightness) > 0) || PANEL_OFF.has(fmt(rgb))) return value
  if (!isDark(rgb, brightness, pwmBits)) return value
  const top = Math.max(...rgb)
  if (top === 0) return value
  const scaled = rgb.map((v) => Math.round((v * EDGE_LIFT) / top))
  // EDGE_LIFT clears the floor at every brightness; this is only a guard should it ever not.
  let c = scaled
  for (let t = 0.05; isDark(c, brightness, pwmBits) && t <= 1.0001; t += 0.05) c = towardsWhite(scaled, t)
  return fmt(c)
}

// The text size a section is drawn at on `layout`, absent a fontsize in the same write.
export function sectionPx(layout, name) {
  const table = LAYOUT_TEXT_PX[layout]
  if (table && table[name] != null) return table[name]
  return TEXT_PX_FALLBACK[name] ?? TEXT_PX_DEFAULT
}

// The SetSections WRITE array as the panel should get it. Returns the same array when nothing
// changes (and never mutates it: mapper output is also what the console mirror is built from).
export function ledSafeSections(sections, { layout, brightness, pwmBits = PANEL_PWM_BITS } = {}) {
  if (!Array.isArray(sections) || !(Number(brightness) > 0)) return sections
  const sizes = new Map()
  for (const s of sections) {
    if (s && s.value && s.value.attrib === 'fontsize') {
      const px = Number(s.value.value)
      if (Number.isFinite(px) && px > 0) sizes.set(s.name, px)
    }
  }
  const opts = { brightness, pwmBits }
  let changed = false
  const out = sections.map((s) => {
    const a = s && s.value && s.value.attrib
    let next
    if (a === 'color' && TEXT_SLOTS.has(s.name)) {
      next = textColor(s.value.value, sizes.get(s.name) ?? sectionPx(layout, s.name), opts)
    } else if (EDGE_SLOTS[a] && EDGE_SLOTS[a].has(s.name)) {
      next = edgeColor(s.value.value, opts)
    } else {
      return s
    }
    if (next === s.value.value) return s
    changed = true
    return { ...s, value: { ...s.value, value: next } }
  })
  return changed ? out : sections
}
