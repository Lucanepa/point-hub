// The console's embed mode (android/BRIDGE.md, "Native Game tab"): from app 1.1.0 the tablet app
// draws the header, the tab bar and the Game tab itself, natively, and shows this console under its
// tab bar for Link, History, Diagnostics and Settings. Asserted against web/index.html:
//
//   [1] from source: asked once, right after the bridge is detected, only `true` counts; the
//       stylesheet drops everything that is the Game tab's or the header's; every bridge call goes
//       through appCall; the console uses exactly the methods and tab names BRIDGE.md lists
//   [2] in a plain browser: no embed class, no pointhubEmbed — the console as it always was
//   [3] in an app that does not ask for it (an older app, the admin's web-console switch, a throw)
//   [4] embed mode at boot: Link underneath, no lock gate, no sport picker, the theme reported
//   [5] the app's way in, pointhubEmbed.show: the four tabs only, never a showTab back
//   [6] the console's way out, showTab: the Game tab, a schedule start, the beach serve order,
//       the uplink chip, and the app's echo of a move the console made
//   [7] the scorer PIN is the app's: every write carries scorerPin(), a 403 is pinRejected()
//       and never the console's own pad, a PIN learned or forgotten goes to setScorerPin()
//   [8] the theme and settings saves go to the app
//   [9] the poll still does everything but the Game tab's prompts (backups, the self-update)
//
// No browser here, as in the other console selftests: the page's own markup is parsed into a small
// fake DOM — enough of one for the console to boot, poll and switch tabs — and the WHOLE console
// script (with the theme boot script before it) runs in it in a vm, against a fake board behind
// fetch and a fake window.PointHubApp. Layout is not modelled, so what the stylesheet hides is
// asserted from source in [1]. A DOM call the console starts making that the fake lacks fails
// here loudly, naming it — add it to the fake.
//
// Plain node, no framework; exits non-zero on any failure.

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }
process.on('unhandledRejection', (e) => { fail++; console.log('  ❌ unhandled rejection in the console:', (e && e.stack) || e) })

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const index = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8')
const bridgeMd = fs.readFileSync(path.join(root, 'android', 'BRIDGE.md'), 'utf8')
const themeBoot = (index.match(/<script id="themeBoot">([\s\S]*?)<\/script>/) || [])[1] || ''
const js = (index.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || ''
const css = ((index.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '').replace(/\/\*[\s\S]*?\*\//g, '')
const markup = index.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '')
  .replace(/<html[^>]*>/, '').replace(/<\/html>/, '')

// ─── a small fake DOM ─────────────────────────────────────────────────────────────────────────
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const REFLECT = ['title', 'href', 'placeholder', 'src', 'alt', 'name', 'rel', 'content', 'download', 'min', 'max', 'step', 'role', 'lang', 'pattern']
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

class FakeEvent {
  constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; this.defaultPrevented = false; this.target = null; this.currentTarget = null; this._stop = false }
  preventDefault() { this.defaultPrevented = true }
  stopPropagation() { this._stop = true }
  stopImmediatePropagation() { this._stop = true }
}
const listen = (o, type, fn, opts) => { (o._ls[type] ||= []).push({ fn, once: !!(opts && opts.once) }) }
const unlisten = (o, type, fn) => { o._ls[type] = (o._ls[type] || []).filter((l) => l.fn !== fn) }
function fire(o, ev) {
  ev.currentTarget = o
  for (const l of [...(o._ls[ev.type] || [])]) {
    if (l.once) unlisten(o, ev.type, l.fn)
    l.fn.call(o, ev)
  }
}

class ClassList {
  constructor() { this.s = new Set() }
  _set(v) { this.s = new Set(String(v).split(/\s+/).filter(Boolean)) }
  add(...c) { c.forEach((x) => this.s.add(x)) }
  remove(...c) { c.forEach((x) => this.s.delete(x)) }
  toggle(c, force) { const on = force === undefined ? !this.s.has(c) : !!force; on ? this.s.add(c) : this.s.delete(c); return on }
  contains(c) { return this.s.has(c) }
  get value() { return [...this.s].join(' ') }
}

class Text {
  constructor(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null }
  get textContent() { return this.data }
  set textContent(v) { this.data = String(v) }
  remove() { if (this.parentNode) this.parentNode.removeChild(this) }
}

class El {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.nodeType = 1
    this.localName = String(tag).toLowerCase(); this.tagName = this.localName.toUpperCase()
    this.parentNode = null; this.childNodes = []; this._ls = {}; this._attrs = new Map()
    this.classList = new ClassList(); this.dataset = {}; this.id = ''
    this.hidden = false; this.disabled = false; this.checked = false; this.value = ''
    this.scrollTop = 0; this.scrollLeft = 0; this._scrolls = 0; this._focus = 0
    const style = { setProperty(k, v) { this[k] = String(v) }, removeProperty(k) { delete this[k] }, getPropertyValue(k) { return this[k] || '' } }
    this.style = style
  }
  // attributes
  setAttribute(k, v) {
    k = String(k).toLowerCase(); v = String(v)
    if (k === 'class') this.classList._set(v)
    else if (k === 'id') this.id = v
    else if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = v
    else if (k === 'hidden') this.hidden = true
    else if (k === 'disabled') this.disabled = true
    else if (k === 'checked') this.checked = true
    else if (k === 'value') { this.value = v; this._attrs.set(k, v) }
    else this._attrs.set(k, v)
  }
  getAttribute(k) {
    k = String(k).toLowerCase()
    if (k === 'class') return this.classList.s.size ? this.className : null
    if (k === 'id') return this.id || null
    if (k.startsWith('data-')) { const c = camel(k.slice(5)); return c in this.dataset ? String(this.dataset[c]) : null }
    if (k === 'hidden') return this.hidden ? '' : null
    if (k === 'disabled') return this.disabled ? '' : null
    return this._attrs.has(k) ? this._attrs.get(k) : null
  }
  hasAttribute(k) { return this.getAttribute(k) !== null }
  removeAttribute(k) {
    k = String(k).toLowerCase()
    if (k === 'class') this.classList._set('')
    else if (k.startsWith('data-')) delete this.dataset[camel(k.slice(5))]
    else if (k === 'hidden') this.hidden = false
    else if (k === 'disabled') this.disabled = false
    else this._attrs.delete(k)
  }
  get className() { return this.classList.value }
  set className(v) { this.classList._set(v) }
  get type() { return this._attrs.get('type') || (this.localName === 'input' ? 'text' : this.localName === 'button' ? 'submit' : '') }
  set type(v) { this._attrs.set('type', String(v)) }
  // tree
  get children() { return this.childNodes.filter((n) => n.nodeType === 1) }
  get firstChild() { return this.childNodes[0] || null }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null }
  get firstElementChild() { return this.children[0] || null }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null }
  get nextElementSibling() { const p = this.parentNode; if (!p || !p.children) return null; const c = p.children; return c[c.indexOf(this) + 1] || null }
  get previousElementSibling() { const p = this.parentNode; if (!p || !p.children) return null; const c = p.children; return c[c.indexOf(this) - 1] || null }
  get isConnected() { for (let n = this; n; n = n.parentNode) if (n === this.ownerDocument) return true; return false }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n }
  append(...ns) { for (const n of ns) this.appendChild(typeof n === 'string' ? new Text(n) : n) }
  prepend(...ns) { ns.reverse().forEach((n) => this.insertBefore(typeof n === 'string' ? new Text(n) : n, this.firstChild)) }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n)
    if (n.parentNode) n.parentNode.removeChild(n)
    n.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); return n
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n }
  remove() { if (this.parentNode) this.parentNode.removeChild(this) }
  replaceWith(n) { const p = this.parentNode; if (!p) return; p.insertBefore(typeof n === 'string' ? new Text(n) : n, this); p.removeChild(this) }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false }
  get textContent() { return this.childNodes.map((n) => n.textContent).join('') }
  set textContent(v) { for (const n of this.childNodes) n.parentNode = null; this.childNodes = []; if (String(v) !== '') this.appendChild(new Text(v)) }
  get innerHTML() { return this._html || '' }
  set innerHTML(v) { for (const n of this.childNodes) n.parentNode = null; this.childNodes = []; this._html = String(v); parseInto(this, String(v)) }
  // queries
  querySelector(sel) { return query(this, sel, true) }
  querySelectorAll(sel) { return query(this, sel, false) }
  matches(sel) { return compile(sel).some((parts) => matchParts(this, parts)) }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null }
  // events
  addEventListener(t, f, o) { listen(this, t, f, o) }
  removeEventListener(t, f) { unlisten(this, t, f) }
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this
    for (let n = this; n; n = n.parentNode) {
      fire(n, ev)
      if (!ev.bubbles || ev._stop) break
      if (n === this.ownerDocument) { if (this.ownerDocument._win) fire(this.ownerDocument._win, ev); break }
    }
    return !ev.defaultPrevented
  }
  click() { if (this.disabled) return; this.dispatchEvent(new FakeEvent('click', { bubbles: true })) }
  focus() { this.ownerDocument.activeElement = this; this._focus++ }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body }
  select() {}
  scrollIntoView() { this._scrolls++ }
  // layout: none. Shown = nothing up the tree carries `hidden` (the stylesheet is not modelled).
  getClientRects() { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.hidden) return []; return [{}] }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } }
  get offsetWidth() { return 0 } get offsetHeight() { return 0 } get offsetLeft() { return 0 } get offsetTop() { return 0 }
  get clientWidth() { return 0 } get clientHeight() { return 0 } get scrollWidth() { return 0 } get scrollHeight() { return 0 }
}
for (const k of REFLECT) Object.defineProperty(El.prototype, k, {
  get() { return this._attrs.has(k) ? this._attrs.get(k) : '' },
  set(v) { this._attrs.set(k, String(v)) },
})

// Markup → nodes. The page is hand-written and closes its tags; void elements and `/>` are known.
const TOKEN = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g
const ATTR = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
function parseInto(parent, html) {
  const doc = parent.ownerDocument
  const stack = [parent]
  for (const m of html.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]
    if (m[1]) {                                   // </tag>
      const t = m[1].toLowerCase()
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].localName === t) { stack.length = i; break }
    } else if (m[2]) {                            // <tag …>
      const el = new El(doc, m[2])
      let attrs = m[3] || ''
      const selfClosing = /\/\s*$/.test(attrs)
      if (selfClosing) attrs = attrs.replace(/\/\s*$/, '')
      for (const a of attrs.matchAll(ATTR)) el.setAttribute(a[1], a[2] ?? a[3] ?? a[4] ?? '')
      top.appendChild(el)
      if (!selfClosing && !VOID.has(el.localName)) stack.push(el)
    } else if (m[4] && !m[0].startsWith('<!--')) {
      top.appendChild(new Text(m[4]))
    }
  }
  return parent
}

// Selectors: tag, #id, .class, [attr], [attr=value] (quoted or not), descendant and child
// combinators, comma lists. Pseudo-classes are not modelled and match nothing.
const SELECTORS = new Map()
function splitTop(s, ch) {
  const out = []; let depth = 0, cur = ''
  for (const c of s) {
    if (c === '[' || c === '(') depth++
    else if (c === ']' || c === ')') depth--
    if (c === ch && depth === 0) { out.push(cur); cur = '' } else cur += c
  }
  out.push(cur)
  return out
}
function compound(t) {
  const c = { tag: null, id: null, classes: [], attrs: [], never: false }
  let rest = t, m
  if ((m = /^(\*|[a-zA-Z][\w-]*)/.exec(rest))) { if (m[1] !== '*') c.tag = m[1].toLowerCase(); rest = rest.slice(m[0].length) }
  while (rest) {
    if ((m = /^#([\w-]+)/.exec(rest))) c.id = m[1]
    else if ((m = /^\.([\w-]+)/.exec(rest))) c.classes.push(m[1])
    else if ((m = /^\[([\w-]+)(?:(=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest))) c.attrs.push({ name: m[1].toLowerCase(), value: m[2] ? (m[3] ?? m[4] ?? m[5]) : null })
    else if ((m = /^:[\w-]+(\([^)]*\))?/.exec(rest))) c.never = true
    else throw new Error(`fake DOM: cannot read the selector part "${rest}" — teach compound() about it`)
    rest = rest.slice(m[0].length)
  }
  return c
}
function compile(sel) {
  if (SELECTORS.has(sel)) return SELECTORS.get(sel)
  const list = splitTop(sel, ',').map((part) => {
    const out = []; let comb = ' '
    for (const t of part.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/)) {
      if (t === '>') { comb = '>'; continue }
      out.push({ comb, ...compound(t) }); comb = ' '
    }
    return out
  })
  SELECTORS.set(sel, list)
  return list
}
function matchOne(el, c) {
  if (el.nodeType !== 1 || c.never) return false
  if (c.tag && el.localName !== c.tag) return false
  if (c.id && el.id !== c.id) return false
  for (const k of c.classes) if (!el.classList.contains(k)) return false
  for (const a of c.attrs) { const v = el.getAttribute(a.name); if (v === null || (a.value !== null && v !== a.value)) return false }
  return true
}
function matchParts(el, parts, i = parts.length - 1) {
  if (!matchOne(el, parts[i])) return false
  if (i === 0) return true
  if (parts[i].comb === '>') { const p = el.parentNode; return !!p && p.nodeType === 1 && matchParts(p, parts, i - 1) }
  for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (matchParts(p, parts, i - 1)) return true
  return false
}
function* walk(node) { for (const c of node.childNodes) if (c.nodeType === 1) { yield c; yield* walk(c) } }
function query(rootNode, sel, first) {
  const doc = rootNode.ownerDocument || rootNode
  const idOnly = /^#([\w-]+)$/.exec(sel.trim())
  if (idOnly && first) { const el = doc.getElementById(idOnly[1]); return el && rootNode.contains(el) && el !== rootNode ? el : null }
  const list = compile(sel), out = []
  for (const el of walk(rootNode)) if (list.some((parts) => matchParts(el, parts))) { if (first) return el; out.push(el) }
  return first ? null : out
}

function makeDocument() {
  const doc = { nodeType: 9, _ls: {}, activeElement: null, visibilityState: 'visible', hidden: false, fullscreenElement: null, _byId: new Map() }
  doc.ownerDocument = doc
  doc.childNodes = []
  doc.contains = (n) => { for (let x = n; x; x = x.parentNode) if (x === doc) return true; return false }
  const html = new El(doc, 'html'); html.parentNode = doc; doc.childNodes.push(html); html.setAttribute('lang', 'en')
  const body = new El(doc, 'body'); html.appendChild(body)
  doc.documentElement = html; doc.body = body; doc.head = body; doc.activeElement = body
  parseInto(body, markup)
  // A <select> reads as its selected (else first) option.
  for (const s of walk(body)) if (s.localName === 'select') {
    const opts = s.querySelectorAll('option')
    const pick = opts.find((o) => o._attrs.has('selected')) || opts[0]
    if (pick) s.value = pick.getAttribute('value') ?? pick.textContent
  }
  doc.getElementById = (id) => {
    const hit = doc._byId.get(id)
    if (hit && hit.id === id && hit.isConnected) return hit
    for (const el of walk(html)) if (el.id === id) { doc._byId.set(id, el); return el }
    return null
  }
  doc.querySelector = (sel) => query(html, sel, true) || (matchOne(html, compound(sel.trim())) ? html : null)
  doc.querySelectorAll = (sel) => query(html, sel, false)
  doc.createElement = (t) => new El(doc, t)
  doc.createTextNode = (t) => new Text(t)
  doc.addEventListener = (t, f, o) => listen(doc, t, f, o)
  doc.removeEventListener = (t, f) => unlisten(doc, t, f)
  doc.dispatchEvent = (ev) => { if (!ev.target) ev.target = doc; fire(doc, ev); return true }
  return doc
}
// ─── the rest of the browser, the board, the app ─────────────────────────────────────────────
function fakeTimers() {
  let now = 0, seq = 0
  const q = new Map()
  const add = (f, ms, every) => { const id = ++seq; q.set(id, { at: now + Math.max(0, Number(ms) || 0), f, every }); return id }
  return {
    setTimeout: (f, ms) => add(f, ms, 0),
    setInterval: (f, ms) => add(f, ms, Math.max(1, Number(ms) || 1)),
    clear: (id) => { q.delete(id) },
    async advance(ms) {
      const end = now + ms
      for (;;) {
        let next = null
        for (const [id, t] of q) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t]
        if (!next) break
        const [id, t] = next
        now = t.at
        if (t.every) t.at = now + t.every; else q.delete(id)
        t.f()
        await flush()
      }
      now = end
    },
  }
}
const flush = async (n = 25) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) }, removeItem: (k) => { m.delete(k) }, clear: () => m.clear(), get length() { return m.size }, _m: m }
}

const STATE = () => ({
  team_a_short: 'KSCW', team_b_short: 'VBC', team_a_name: 'KSC Wiedikon H1', team_b_name: 'VBC Züri', team_a_color: '#2563eb', team_b_color: '#ef4444',
  points_a: 0, points_b: 0, sets_won_a: 0, sets_won_b: 0, timeouts_a: 0, timeouts_b: 0, subs_a: 0, subs_b: 0,
  side_a: 'left', serving_team: 'left', set_results: [],
})
// The board, as far as the console can tell: the routes it calls, with the scorer PIN enforced on
// every write the way src/controlServer.js does (403 when it is wrong or missing).
function makeBoard({ pin = '', sport = 'volleyball', liveScoring = 'off', gameId = null, build = 'b1' } = {}) {
  const b = {
    pin, sport, build, gameId, state: STATE(),
    settings: { sport, orientation: 'behind', liveScoring, timeoutSeconds: 30, setIntervalSeconds: 180, warmupSeconds: 600, totalTimeouts: 2, totalSubs: 6, matchFontMaxLeft: 18, matchFontMaxRight: 18, branding: 'kscw', bestOf: 5, relayAddress: '', autoPrepare: true },
    game: { id: 4711, date: '2026-10-18', time: '19:30', home: 'KSC Wiedikon H1', away: 'VBC Züri', homeShort: 'KSCW H1', awayShort: 'ZÜRI', league: '3. Liga Herren', hall: 'KWI A' },
  }
  const json = (status, body) => [status, body]
  b.route = (method, p, body, headers) => {
    const pinOk = !b.pin || headers['X-Scorer-Pin'] === b.pin
    const write = method !== 'GET'
    const gated = write && !['/api/logs', '/api/unlock', '/api/gamesheet'].includes(p)
    if (gated && !pinOk) return json(403, { error: 'scorer PIN required' })
    if (p === '/api/status') return json(200, { sport: b.sport, mode: 'manual', build: b.build, gameId: b.gameId, matchId: null, prematch: false,
      ledbox: { connected: true, host: 'mock', port: 1 }, state: b.state, pinRequired: !!b.pin, uplink: { status: 'online' }, canUndo: false })
    if (p === '/api/settings' && method === 'GET') return json(200, { ...b.settings, pinSet: !!b.pin })
    if (p === '/api/settings') {
      if (body.clearPin) b.pin = ''
      if (body.scorerPin) b.pin = body.scorerPin
      const { clearPin, scorerPin, ...rest } = body
      Object.assign(b.settings, rest)
      return json(200, { ...b.settings, pinSet: !!b.pin })
    }
    if (p === '/api/sport') return json(200, { sport: b.sport, sports: [{ key: 'volleyball', label: 'Volleyball' }, { key: 'beach', label: 'Beach volleyball' }] })
    if (p === '/api/unlock') return json(200, { ok: !b.pin || (body && body.pin) === b.pin })
    if (p === '/api/clock') return json(200, { ok: true, applied: false, reason: 'synced' })
    if (p === '/api/schedule') return json(200, { ok: true, date: '2026-10-18', today: [b.game], upcoming: [] })
    if (p === '/api/game' && method === 'GET') return json(200, { sport: b.sport, saved: null })
    if (p === '/api/game') return json(200, { ok: true, sport: b.sport, state: b.state, prematch: body.prematch === true })
    if (p === '/api/gamesheet') {
      const info = { id: b.gameId, home: b.game.home, away: b.game.away, league: b.game.league, kscwIsHome: true, referees: [] }
      const sent = headers['X-Scorer-Pin']
      const roster = !sent ? { ok: false, locked: true, error: 'The roster holds birthdates — enter the scorer PIN to see it.' }
        : sent !== b.pin ? { ok: false, locked: true, error: 'Wrong scorer PIN — enter it again to see the roster.' }
        : { ok: true, players: [{ number: 7, lastName: 'Muster', initial: 'A.', birthdate: '2001-02-03' }], officials: [] }
      return json(200, { ok: true, live: true, info, roster })
    }
    if (p === '/api/history') return json(200, { matches: [] })
    if (p === '/api/history/current') return json(200, { match: null })
    if (p === '/api/uplink') return json(200, { status: 'online', step: 'idle' })
    if (p === '/api/matches') return json(200, { matches: [], errors: [] })
    if (p === '/api/system') return json(200, { at: new Date().toISOString(), clock: {}, cpu: {}, disk: {}, host: {}, mem: {}, net: [] })
    if (p === '/api/logs') return json(200, { ok: true, stats: { startedAt: 'run-1', lastId: 0 } })
    if (['/api/idle', '/api/action', '/api/countdown', '/api/countdown/stop', '/api/result', '/api/link'].includes(p)) return json(200, { ok: true, state: b.state })
    return json(404, { error: 'no such route in the fake board: ' + p })
  }
  return b
}

// window.PointHubApp as android/BRIDGE.md describes it. Only strings, booleans and void come back.
// `omit` drops methods (an older app); `nativeGame` is what that method answers (or a function).
function makeApp({ nativeGame = true, pin = '', omit = [] } = {}) {
  const app = { calls: [], pin, pinReads: 0 }
  const rec = (name, ...a) => app.calls.push([name, ...a])
  const m = {
    getInfo: () => JSON.stringify({ app: 'pointhub-android', versionCode: 13, versionName: '1.1.0' }),
    keepAwake: (on) => rec('keepAwake', on),
    saveBackup: (name, json) => { rec('saveBackup', name, json.length); return true },
    listBackups: () => '[]',
    exportBackups: () => false,
    saveSchedule: () => { rec('saveSchedule'); return true },
    loadSchedule: () => null,
    reloadConsole: () => rec('reloadConsole'),
    openSettings: () => rec('openSettings'),
    nativeGame: () => { rec('nativeGame'); return typeof nativeGame === 'function' ? nativeGame() : nativeGame },
    showTab: (name) => rec('showTab', name),
    scorerPin: () => { app.pinReads++; return app.pin },
    setScorerPin: (p) => { rec('setScorerPin', p); app.pin = p },
    pinRejected: () => { rec('pinRejected'); app.pin = '' },
    settingsChanged: () => rec('settingsChanged'),
    setTheme: (t) => rec('setTheme', t),
  }
  for (const k of omit) delete m[k]
  app.bridge = m
  app.named = (name) => app.calls.filter((c) => c[0] === name)
  return app
}

class FakeES { constructor(url) { this.url = url; this.closed = false; FakeES.all.push(this) } close() { this.closed = true } }
FakeES.all = []

function boot({ app = null, board = makeBoard(), store = {}, search = '' } = {}) {
  const T = fakeTimers()
  const doc = makeDocument()
  const io = { requests: [] }
  const local = fakeStorage(store), session = fakeStorage()
  const fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://172.24.1.1:8890')
    const method = (opts.method || 'GET').toUpperCase()
    const headers = opts.headers || {}
    const body = opts.body ? JSON.parse(opts.body) : null
    io.requests.push({ path: u.pathname, search: u.search, method, headers, body })
    const [status, payload] = board.route(method, u.pathname, body, headers)
    return { status, ok: status >= 200 && status < 300, json: async () => payload }
  }
  const win = {
    document: doc, navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36' + (app ? ' PointHubApp/1.1.0' : '') },
    screen: { width: 1280, height: 800, orientation: { lock: () => Promise.resolve() } },
    location: { href: 'http://172.24.1.1:8890/' + search, origin: 'http://172.24.1.1:8890', protocol: 'http:', host: '172.24.1.1:8890', pathname: '/', search, hash: '',
      reload() { io.reloaded = (io.reloaded || 0) + 1 }, replace(u) { io.replaced = u }, assign(u) { io.assigned = u } },
    history: { state: null, length: 1, replaceState() {} },
    localStorage: local, sessionStorage: session,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ zIndex: '0', getPropertyValue: () => '' }),
    MutationObserver: class { observe() {} disconnect() {} },
    EventSource: FakeES, Event: FakeEvent, Blob: class {},
    fetch, AbortSignal: { timeout: () => undefined }, AbortController, TextEncoder, URL, URLSearchParams,
    setTimeout: T.setTimeout, setInterval: T.setInterval, clearTimeout: T.clear, clearInterval: T.clear,
    console, innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0, scrollTo() {}, isSecureContext: false,
    _ls: {},
  }
  win.addEventListener = (t, f, o) => listen(win, t, f, o)
  win.removeEventListener = (t, f) => unlisten(win, t, f)
  win.dispatchEvent = (ev) => { if (!ev.target) ev.target = win; fire(win, ev); return true }
  win.window = win; win.self = win; win.top = win
  if (app) win.PointHubApp = app.bridge
  doc._win = win
  vm.createContext(win)
  vm.runInContext(themeBoot, win, { filename: 'themeBoot.js' })
  vm.runInContext(js, win, { filename: 'console.js' })
  doc.dispatchEvent(new FakeEvent('DOMContentLoaded'))
  const $ = (s) => doc.querySelector(s)
  return {
    win, doc, io, board, app, T, $, local,
    html: doc.documentElement,
    poll: async () => { await T.advance(1600); await flush() },
    req: (p, method) => io.requests.filter((r) => r.path === p && (!method || r.method === method)),
    activeTab: () => (doc.querySelectorAll('.tab').find((t) => t.classList.contains('active')) || {}).id || '',
    activeNav: () => (doc.querySelectorAll('.nav button[data-tab]').filter((b) => b.classList.contains('active')).map((b) => b.dataset.tab)).join(),
    storage: (key) => { const ev = new FakeEvent('storage'); ev.key = key; win.dispatchEvent(ev) },
  }
}
// The confirm dialog the console opens before a destructive or game-starting tap: answer it.
async function answer(p, yes = true) {
  await flush()
  if (p.$('#confirm').hidden) return false
  p.$(yes ? '#confirmYes' : '#confirmNo').click()
  await flush()
  return true
}
const bodyOf = (name) => {
  const at = js.search(new RegExp(`(async\\s+)?function ${name}\\(`))
  if (at < 0) return ''
  let i = js.indexOf('{', js.indexOf(')', at)), depth = 0
  for (; i < js.length; i++) { if (js[i] === '{') depth++; else if (js[i] === '}' && --depth === 0) return js.slice(at, i + 1) }
  return ''
}

// ─── [1] ─────────────────────────────────────────────────────────────────────────────────────
console.log('[1] from source: the question, the stylesheet, the contract')
{
  const detect = js.indexOf('const IN_APP = !!APP_BRIDGE;'), ask = js.indexOf('const EMBED = IN_APP && appCall("nativeGame") === true;')
  ok(ask > detect && detect > 0, 'EMBED is asked once, right after the bridge is detected: IN_APP && appCall("nativeGame") === true')
  ok(/if \(EMBED\) \{\s*document\.documentElement\.classList\.add\("embed"\);/.test(js), 'and marks <html class="embed">')
  ok(js.indexOf('const EMBED =') < js.indexOf('let SCORER_PIN'), 'before anything that reads the PIN, opens a dialog or polls')
  const hide = ['.topbar', '#tab-manual', '#cd', '#offline', '#rotate', '#lockGate', '#sportPicker', '#gamePicker', '#matchEnd', '#serveOrder', '#liveLog', '#pinModal']
  const rule = (css.match(/((?:html\.embed [^,{]+,\s*)*html\.embed [^,{]+)\{display:none!important\}/) || [])[1] || ''
  const hidden = rule.split(',').map((s) => s.trim().replace(/^html\.embed /, ''))
  ok(hide.every((s) => hidden.includes(s)), `the stylesheet drops ${hide.join(' ')}`)
  ok(!/:is\(/.test(rule), 'as a plain selector list (an old WebView without :is() still drops every one)')
  const kept = ['#tab-link', '#tab-history', '#tab-diag', '#tab-settings', '#toast', '#confirm', '#edit', '#updateBar', '#shutdown']
  ok(!kept.some((s) => hidden.includes(s)) && !/html\.embed[^{]*(#toast|#confirm|#updateBar|#shutdown|#tab-link|#tab-settings)/.test(css), 'and keeps the four tabs, toasts, the confirm and edit dialogs, the update bar and the shutdown screen')
  ok(!/\bPointHubApp\.\w+\(/.test(js), 'no call on window.PointHubApp bypasses appCall')
  // Every console → app method in BRIDGE.md's embed table, and nothing else new, goes through appCall.
  const section = bridgeMd.slice(bridgeMd.indexOf('## Native Game tab (embed mode)'))
  const table = section.slice(section.indexOf('### Methods (console → app)'), section.indexOf('### The console\'s global'))
  const methods = [...table.matchAll(/^\| `(\w+)\(/gm)].map((m) => m[1])
  ok(methods.join() === 'nativeGame,showTab,scorerPin,setScorerPin,pinRejected,settingsChanged,setTheme', `BRIDGE.md lists ${methods.join(', ')}`)
  ok(methods.every((m) => js.includes(`appCall("${m}"`)), 'and the console calls every one of them through appCall')
  const showNames = [...((section.match(/`show\(name, anchor\?\)` \| Show console tab `name` \(([^)]*)\)/) || [])[1] || '').matchAll(/"(\w+)"/g)].map((m) => m[1])
  const consoleNames = JSON.parse(((js.match(/const EMBED_TABS = (\[[^\]]*\]);/) || [])[1] || '[]'))
  ok(showNames.length === 4 && showNames.join() === consoleNames.join(), `show() takes exactly BRIDGE.md's tabs (${consoleNames.join(', ')})`)
  const tabNames = [...((table.match(/^\| `showTab\(name\)` \|[^\n]*$/m) || [])[0] || '').matchAll(/"([\w-]+)"/g)].map((m) => m[1])
  ok(tabNames.join() === 'game,link,history,diag,settings,serve-order', `BRIDGE.md's showTab takes ${tabNames.join(', ')}`)
  const sent = [...new Set([...js.matchAll(/appCall\("showTab", "([\w-]+)"\)/g)].map((m) => m[1]).concat(/"serve-order" : "game"/.test(js) ? ['serve-order', 'game'] : []))]
  ok(sent.length >= 2 && sent.every((n) => tabNames.includes(n)), `the literal tabs the console sends to showTab are BRIDGE.md's (${sent.join(', ')})`)
  ok(/if \(EMBED\) \{\s*const EMBED_TABS[\s\S]*?window\.pointhubEmbed = Object\.freeze\(/.test(js), 'window.pointhubEmbed exists only in embed mode, and cannot be rewritten')
  ok(!/appCall\("showTab"/.test(js.slice(js.indexOf('window.pointhubEmbed = Object.freeze('), js.indexOf('startPolling();\n})();'))), 'show() itself never calls showTab')
  ok(/const pinNow = \(\) => \(EMBED \? String\(appCall\("scorerPin"\) \|\| ""\) : SCORER_PIN\);/.test(js), 'pinNow(): the app\'s PIN in embed mode, SCORER_PIN everywhere else')
  ok(/"X-Scorer-Pin": pinNow\(\)/.test(bodyOf('api') + js.slice(js.indexOf('const postJSON'), js.indexOf('let lastLedbox'))) && /"X-Scorer-Pin": pinNow\(\)/.test(js.slice(js.indexOf('const uplinkPost'))), 'every write sends pinNow(): postJSON and the hall-login posts')
  ok(/const pin = pinNow\(\);[\s\S]{0,40}if \(pin\) headers\["X-Scorer-Pin"\] = pin;/.test(bodyOf('refreshSheet')), 'and so does the match sheet\'s roster request')
  ok(!/X-Scorer-Pin"?\]?\s*[:=]\s*SCORER_PIN/.test(js), 'nothing sends SCORER_PIN directly any more')
  ok(/if \(EMBED\) return;/.test(bodyOf('maybeAskEndMatch')) && /if \(EMBED\) return;/.test(bodyOf('maybePromptServeOrder'))
    && /if \(EMBED\) return;/.test(bodyOf('showBoardLive')) && /if \(EMBED\) return;/.test(bodyOf('startCountdown')) && /if \(EMBED\) return;/.test(bodyOf('showSetEndPrompt')),
    'the Game-tab prompts, showBoardLive and the countdowns are no-ops in embed mode')
  ok(/if \(EMBED\) return;/.test(bodyOf('openSportPicker')) && /if \(EMBED\) return;/.test(bodyOf('openGamePicker')) && /if \(EMBED\) return;/.test(bodyOf('showMatchEnd')) && /if \(EMBED\) return;/.test(bodyOf('openServeOrder')),
    'and so are the Game tab\'s own dialogs (the result would otherwise reach the panel)')
  ok(/if \(EMBED\) loadSportList\(\);\s*else loadSportList\(\)\.then\(openSportPicker\);/.test(js), 'the sport list still loads at boot; only the picker is skipped')
}

// ─── [2] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[2] in a plain browser: the console as it always was')
{
  const p = boot()
  await flush()
  ok(!p.html.classList.contains('embed') && !p.html.classList.contains('in-app'), 'no embed class (and no in-app)')
  ok(p.win.pointhubEmbed === undefined, 'no window.pointhubEmbed')
  ok(p.activeTab() === 'tab-manual' && p.activeNav() === 'manual', 'it opens on the Game tab')
  ok(p.$('#sportPicker').hidden === false, 'with the sport picker up')
  ok(p.$('#lockGate').hidden === true, 'an open board lifts the lock gate (bootLock ran)')
  ok(p.req('/api/clock', 'POST').length === 1, 'and the board was handed the tablet\'s clock')
  // A 403 opens the console's own PIN pad — the contrast to [7].
  const q = boot({ board: makeBoard({ pin: '2468' }) })
  await flush()
  ok(q.$('#lockGate').hidden === false, 'a board with a PIN keeps the gate up until it is typed')
  q.$('#pinClear').click()
  await answer(q)
  ok(q.req('/api/settings', 'POST').length === 1 && q.$('#pinModal').hidden === false, 'a write the board refuses (403) opens the console\'s PIN pad')
  // The end-of-match prompt really runs in this harness — so its absence in [9] means something.
  q.board.state = { ...STATE(), sets_won_a: 3, sets_won_b: 1, set_results: [{ a: 25, b: 20 }, { a: 20, b: 25 }, { a: 25, b: 18 }, { a: 25, b: 22 }] }
  q.$('#spCancel').click(); q.$('#pinCancel').click()
  await q.poll()
  ok(q.$('#confirm').hidden === false && /Match finished/.test(q.$('#confirmMsg').textContent), 'a finished match asks "Match finished — show the result?"')
}

// ─── [3] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[3] in an app that does not ask for it')
{
  const EMBED_CALLS = ['showTab', 'setScorerPin', 'pinRejected', 'settingsChanged', 'setTheme']
  for (const [label, opts] of [
    ['an older app (no nativeGame)', { omit: ['nativeGame', ...EMBED_CALLS, 'scorerPin'] }],
    ['the admin\'s "Game screen: web console" switch (nativeGame() === false)', { nativeGame: false }],
    ['a nativeGame() that throws', { nativeGame: () => { throw new Error('denied') } }],
    ['a nativeGame() that answers "true" (a string, not true)', { nativeGame: 'true' }],
  ]) {
    const app = makeApp(opts)
    const p = boot({ app, store: { theme: 'dark' } })
    await flush()
    ok(p.html.classList.contains('in-app') && !p.html.classList.contains('embed') && p.win.pointhubEmbed === undefined, `${label}: in-app, not embedded, no pointhubEmbed`)
    ok(p.activeTab() === 'tab-manual' && p.$('#sportPicker').hidden === false, '  the console\'s own Game tab and sport picker, as before')
    if (!opts.omit) {
      ok(app.named('nativeGame').length === 1, '  nativeGame() asked exactly once')
      // Everything embed mode would tell the app, done here: none of it reaches the bridge.
      p.doc.querySelectorAll('[data-theme-pick="eink"]')[0].click()
      p.$('#spCancel').click()
      p.doc.querySelectorAll('.setsavebtn')[0].click()
      await flush(); await p.poll()
      ok(EMBED_CALLS.every((m) => app.named(m).length === 0) && app.pinReads === 0, '  a theme pick, a settings save and a poll make none of the embed calls, and never read scorerPin()')
    }
  }
}

// ─── [4] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[4] embed mode at boot')
{
  const app = makeApp({ nativeGame: true })
  const p = boot({ app, store: { theme: 'dark' } })
  await flush()
  ok(p.html.classList.contains('embed') && p.html.classList.contains('in-app'), '<html class="in-app embed">')
  ok(app.named('nativeGame').length === 1, 'nativeGame() asked exactly once')
  ok(p.activeTab() === 'tab-link' && p.activeNav() === 'link', 'Link is the tab underneath, not the Game tab (nothing blank before the app\'s first show)')
  ok(p.req('/api/schedule').length === 0 && p.req('/api/matches').length === 0, '…set by class only: its refreshes wait for the app\'s show()')
  ok(p.$('#lockGate').hidden === true, 'no lock gate')
  ok(p.$('#sportPicker').hidden === true && p.$('#gamePicker').hidden === true && p.req('/api/game', 'GET').length === 0, 'no sport picker, no game menu')
  ok(p.req('/api/sport', 'GET').length === 1, 'but the sport list is loaded')
  ok(p.req('/api/status').length >= 1, 'and the poll runs')
  ok(JSON.stringify(app.named('setTheme')[0]) === '["setTheme","dark"]', 'the theme is reported at boot: setTheme("dark")')
  ok(app.named('showTab').length === 0, 'no showTab at boot — the app shows what it wants')
  ok(typeof p.win.pointhubEmbed === 'object' && typeof p.win.pointhubEmbed.show === 'function' && Object.isFrozen(p.win.pointhubEmbed), 'window.pointhubEmbed.show is there (frozen)')
  ok(p.req('/api/clock', 'POST').length === 1 && p.req('/api/idle').length === 0 && p.req('/api/countdown').length === 0, 'an open board still gets the tablet\'s clock; nothing touches the panel')
  const gate = boot({ app: makeApp({ pin: '' }), board: makeBoard({ pin: '2468' }) })
  await flush()
  ok(gate.$('#lockGate').hidden === true && gate.req('/api/unlock').length === 0, 'a board with a PIN: still no gate, and no unlock attempt of the console\'s own')
}

// ─── [5] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[5] the app\'s way in: pointhubEmbed.show(name, anchor)')
{
  const app = makeApp()
  const p = boot({ app })
  await flush()
  const show = (...a) => p.win.pointhubEmbed.show(...a)
  let n = app.calls.length
  show('history'); await flush()
  ok(p.activeTab() === 'tab-history' && p.activeNav() === 'history', 'show("history") shows History (button and tab)')
  ok(p.req('/api/history').length === 1, 'and runs its refresh, as a tap on its button does')
  ok(!app.calls.slice(n).some((c) => c[0] === 'showTab'), 'without calling showTab back')
  const reqs = p.io.requests.length
  for (const bad of ['bogus', 'game', 'manual', 'serve-order', '', 'History', 42, null, undefined, { toString: () => 'link' }]) show(bad)
  await flush()
  ok(p.activeTab() === 'tab-history' && p.io.requests.length === reqs, 'anything but link/history/diag/settings is ignored ("game", "manual", "bogus", a number, an object…)')
  show('diag'); await flush()
  const es = FakeES.all[FakeES.all.length - 1]
  ok(p.activeTab() === 'tab-diag' && es && !es.closed && p.req('/api/system').length >= 1, 'show("diag") starts Diagnostics (the log stream and the system poll)')
  {
    const sys0 = p.req('/api/system').length
    p.win.pointhubEmbed.hide(); await flush()
    ok(es.closed && p.activeTab() === 'tab-diag', 'hide() (the native Game tab in front) stops the log stream and the system poll, and leaves the tab as it was')
    show('diag'); await flush()
    const es2 = FakeES.all[FakeES.all.length - 1]
    ok(es2 !== es && !es2.closed && p.req('/api/system').length > sys0, 'and show("diag") afterwards starts them again')
  }
  n = app.calls.length
  show('settings', 'uplink'); await flush()
  const card = p.$('#uplinkCard')
  ok(p.activeTab() === 'tab-settings' && es.closed, 'show("settings", "uplink") opens Settings, and leaving Diagnostics stops it')
  ok(card._scrolls === 1 && card.classList.contains('flash'), 'and scrolls to Hall internet and flashes it, as the uplink chip does')
  ok(!app.calls.slice(n).some((c) => c[0] === 'showTab'), 'still without a showTab back')
  show('link'); await flush()
  ok(p.activeTab() === 'tab-link' && p.req('/api/schedule').length === 1, 'show("link") loads tonight\'s schedule')
  card._scrolls = 0
  show('history', 'uplink'); await flush()
  ok(card._scrolls === 0, 'the "uplink" anchor only means something for Settings')
}

// ─── [6] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[6] the console\'s way out: showTab(name)')
{
  const app = makeApp()
  const p = boot({ app })
  await flush()
  p.win.pointhubEmbed.show('link'); await flush()
  const row = p.$('#schedule button.schedrow')
  ok(!!row, 'the Link tab lists tonight\'s game')
  row.click()
  ok(await answer(p), 'tapping it asks first, in the console\'s own confirm')
  const game = p.req('/api/game', 'POST')[0]
  ok(game && game.body.choice === 'new' && game.body.prematch === true, 'then sets the game up on the board (POST /api/game, pre-match)')
  ok(JSON.stringify(app.named('showTab').pop()) === '["showTab","game"]' && p.activeTab() === 'tab-link', 'and asks the app for its Game tab — showTab("game") — instead of opening the console\'s')
  ok(p.$('#serveOrder').hidden === true && p.$('#cd').hidden === true, 'no console dialog behind it')

  const beachApp = makeApp()
  const b = boot({ app: beachApp, board: makeBoard({ sport: 'beach' }) })
  await flush()
  b.win.pointhubEmbed.show('link'); await flush()
  b.$('#schedule button.schedrow').click(); await answer(b)
  ok(JSON.stringify(beachApp.named('showTab')) === '[["showTab","serve-order"]]', 'a beach game from the schedule: showTab("serve-order") — and only that')
  ok(b.$('#serveOrder').hidden === true, 'never the console\'s own serve-order dialog')

  // goToTab("manual"): the game menu's Continue (never on screen in embed mode, but wired).
  const before = app.named('showTab').length
  p.$('#gpContinue').click(); await flush()
  ok(app.named('showTab').length === before + 1 && app.named('showTab').pop()[1] === 'game', 'goToTab("manual") is showTab("game")')
  ok(p.activeTab() === 'tab-link', 'and never switches the console onto its hidden Game tab')

  // A move the console makes itself: the uplink chip → Settings, and the app's echo of it.
  const uplinks = () => p.req('/api/uplink').length
  const u0 = uplinks()
  p.$('#uplinkTag').click(); await flush()
  ok(p.activeTab() === 'tab-settings' && JSON.stringify(app.named('showTab').pop()) === '["showTab","settings"]', 'goToUplink moves to Settings and tells the app: showTab("settings")')
  ok(uplinks() === u0 + 1 && p.$('#uplinkCard').classList.contains('flash'), 'once, with the card flashed')
  p.win.pointhubEmbed.show('settings'); await flush()
  ok(uplinks() === u0 + 1, 'the app\'s echo show("settings") is recognised: Settings is not refreshed twice')
  p.win.pointhubEmbed.show('settings'); await flush()
  ok(uplinks() === u0 + 2, 'a real tap on Settings after that refreshes it as always')
  // Diagnostics from the sport picker (never shown in embed mode): local switch plus showTab.
  p.$('#spDiag').click(); await flush()
  ok(p.activeTab() === 'tab-diag' && app.named('showTab').pop()[1] === 'diag', 'any other goToTab: switches here and showTab(name)')
  p.win.pointhubEmbed.show('link'); await flush()
}

// ─── [7] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[7] the scorer PIN is the app\'s')
{
  const app = makeApp({ pin: '2468' })
  const board = makeBoard({ pin: '2468' })
  const p = boot({ app, board, store: { kscwScorerPin: '9999' } })
  await flush(); await p.poll()
  const clock = p.req('/api/clock', 'POST')[0]
  ok(clock && clock.headers['X-Scorer-Pin'] === '2468', 'the board is handed the clock with the app\'s PIN, not the stale one in storage')
  ok(!p.doc.body.classList.contains('locked'), 'holding a PIN, the console reads as unlocked')
  p.win.pointhubEmbed.show('link'); await flush()
  p.$('#schedule button.schedrow').click(); await answer(p)
  const game = p.req('/api/game', 'POST').pop()
  ok(game && game.headers['X-Scorer-Pin'] === '2468', 'a console write sends the PIN scorerPin() returns')
  // The app's PIN changes (another unlock on its pad): the very next write carries the new one.
  app.pin = '1111'
  const n = app.calls.length
  p.$('#schedule button.schedrow').click(); await answer(p)
  const refused = p.req('/api/game', 'POST').pop()
  ok(refused && refused.headers['X-Scorer-Pin'] === '1111', 'asked afresh for every write (no copy taken earlier)')
  ok(app.calls.slice(n).filter((c) => c[0] === 'pinRejected').length === 1, 'a 403 calls pinRejected() — once')
  ok(p.$('#pinModal').hidden === true, 'and does not open the console\'s PIN pad')
  ok(p.local.getItem('kscwScorerPin') === null && !app.calls.slice(n).some((c) => c[0] === 'setScorerPin'), 'the console forgets its own copy (pinRejected is the app\'s forgetting — no setScorerPin("") on top)')
  await p.poll()
  ok(p.doc.body.classList.contains('locked'), 'with the app\'s PIN gone, the console reads as locked')
  // The PIN pad from the match sheet's "Enter scorer PIN" is the app's too.
  const sheetApp = makeApp({ pin: '' })
  const s = boot({ app: sheetApp, board: makeBoard({ pin: '2468', liveScoring: 'kscw', gameId: 4711 }) })
  await flush()
  s.win.pointhubEmbed.show('link'); await flush()
  const ask = s.doc.querySelectorAll('#sheet button').find((x) => /Enter scorer PIN/.test(x.textContent))
  ok(!!ask && !s.req('/api/gamesheet')[0].headers['X-Scorer-Pin'], 'a locked roster offers "Enter scorer PIN" (asked without a PIN, as a locked tablet should)')
  ask.click(); await flush()
  ok(sheetApp.named('pinRejected').length === 1 && s.$('#pinModal').hidden === true, 'which asks the APP for the PIN (pinRejected), not the console\'s pad')
  sheetApp.pin = '2468'   // typed on the app's pad
  await s.poll()
  const again = s.req('/api/gamesheet').pop()
  ok(again && again.headers['X-Scorer-Pin'] === '2468', 'the next status notices the app now holds a PIN and asks for the roster again with it')
  ok(s.doc.querySelectorAll('#sheet td.cname').some((td) => /Muster/.test(td.textContent)), 'and the roster is on screen')
  const asked = s.req('/api/gamesheet').length
  await s.poll(); await s.poll()
  ok(s.req('/api/gamesheet').length === asked, 'once — not again on every poll')
  // A PIN learned (Settings ▸ Access) and forgotten (Remove the PIN) goes to the app.
  const setApp = makeApp({ pin: '2468' })
  const t = boot({ app: setApp, board: makeBoard({ pin: '2468' }) })
  await flush(); await t.poll()
  t.win.pointhubEmbed.show('settings'); await flush()
  const pinBox = t.$('[data-set="scorerPin"]'); pinBox.value = '1357'
  pinBox.closest('fieldset').querySelector('.setsavebtn').click(); await flush()
  const saved = t.req('/api/settings', 'POST').pop()
  ok(saved && saved.headers['X-Scorer-Pin'] === '2468' && saved.body.scorerPin === '1357', 'a new PIN is saved with the current one')
  const after = setApp.calls.filter((c) => c[0] === 'setScorerPin' || c[0] === 'settingsChanged').map((c) => c.join(':'))
  ok(after.join() === 'setScorerPin:1357,settingsChanged', `then setScorerPin("1357"), then settingsChanged() (${after.join(', ')})`)
  setApp.calls.length = 0
  t.$('#pinClear').click(); await answer(t)
  const cleared = t.req('/api/settings', 'POST').pop()
  ok(cleared && cleared.body.clearPin === true && cleared.headers['X-Scorer-Pin'] === '1357', 'removing the PIN is sent with the app\'s (new) PIN')
  ok(setApp.calls.map((c) => c.join(':')).join() === 'setScorerPin:,settingsChanged', 'then setScorerPin("") and settingsChanged()')
}

// ─── [8] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[8] the theme and settings saves go to the app')
{
  const app = makeApp()
  const p = boot({ app })
  await flush()
  ok(JSON.stringify(app.named('setTheme')) === '[["setTheme","light"]]', 'no stored theme: setTheme("light") at boot')
  p.win.pointhubEmbed.show('settings'); await flush()
  p.doc.querySelectorAll('[data-theme-pick="eink"]')[0].click()
  ok(p.html.getAttribute('data-theme') === 'eink' && JSON.stringify(app.named('setTheme').pop()) === '["setTheme","eink"]', 'Settings ▸ Theme ▸ E-ink applies it and reports setTheme("eink")')
  p.doc.querySelectorAll('[data-theme-pick="dark"]')[0].click()
  ok(JSON.stringify(app.named('setTheme').pop()) === '["setTheme","dark"]', '…and Dark, setTheme("dark")')
  p.local.setItem('theme', 'light'); p.storage('theme')
  ok(p.html.getAttribute('data-theme') === null && JSON.stringify(app.named('setTheme').pop()) === '["setTheme","light"]', 'a change made in another tab (the storage event) is reported too')
  const n = app.named('settingsChanged').length
  p.doc.querySelectorAll('.setsavebtn')[0].click(); await flush()
  ok(p.req('/api/settings', 'POST').length === 1 && app.named('settingsChanged').length === n + 1, 'a Settings save → settingsChanged()')
  p.doc.querySelectorAll('[data-font="left"][data-d="1"]')[0].click(); await flush()
  ok(p.req('/api/settings', 'POST').length === 2 && app.named('settingsChanged').length === n + 2, 'a name-size −/+ (nudgeFont) → settingsChanged() as well')
  ok(app.named('setScorerPin').length === 0, 'a save without a new PIN says nothing about the PIN')
}

// ─── [9] ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n[9] the poll still does everything but the Game tab\'s prompts')
{
  const app = makeApp()
  const board = makeBoard()
  const p = boot({ app, board })
  await flush()
  board.state = { ...STATE(), points_a: 12, points_b: 9 }
  await p.poll()
  board.state = { ...STATE(), sets_won_a: 1, set_results: [{ a: 25, b: 21 }] }
  await p.poll()
  const bk = app.named('saveBackup').map((c) => c[1])
  ok(bk.some((name) => /^set-end_/.test(name)), `a set end is backed up on the tablet (saveBackup ${bk.join(', ')})`)
  ok(p.$('#cd').hidden === true && p.req('/api/countdown').length === 0, 'no SET ENDED card and no countdown')
  board.state = { ...STATE(), sets_won_a: 3, sets_won_b: 1, set_results: [{ a: 25, b: 20 }, { a: 20, b: 25 }, { a: 25, b: 18 }, { a: 25, b: 22 }] }
  await p.poll(); await p.poll()
  ok(p.$('#confirm').hidden === true && p.$('#matchEnd').hidden === true && p.req('/api/result').length === 0, 'a finished match: no "show the result?", no result dialog, nothing pushed to the panel')
  ok(app.named('saveBackup').some((c) => /^match-end_/.test(c[1])), 'but the match end is backed up')
  const beach = makeApp()
  const bb = makeBoard({ sport: 'beach' })
  const q = boot({ app: beach, board: bb })
  await flush()
  bb.state = { ...STATE(), points_a: 3 }; await q.poll()
  bb.state = { ...STATE(), sets_won_a: 1, set_results: [{ a: 21, b: 15 }] }; await q.poll()
  ok(q.$('#serveOrder').hidden === true, 'a new beach set does not pop the console\'s serve order')
  ok(p.req('/api/idle').length === 0, 'and nothing lifts the panel off the crest (showBoardLive)')
  board.state = STATE(); board.build = 'b2'
  await p.poll()
  ok(app.named('reloadConsole').length === 1, 'a new console build on a quiet board still reloads through the app (noteBuild)')
}

console.log(`\n${fail ? '❌ FAIL' : '✅ PASS'} — embed-mode-selftest: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
