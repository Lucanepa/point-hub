// LEDbox wire protocol (Tech4Sport) — codec + TCP framing.
//
// Per http://apiledbox.tech4sport.com/ every message is a UTF-8 JSON string,
// gzip-compressed, exchanged as { cmd, value } -> { status, sender, value }.
//
// FRAMING CAVEAT: the docs' TCP examples read a raw recv() buffer and gunzip the
// whole thing, implying one gzip member == one message with no length prefix.
// gzip members are self-delimiting (magic 1f 8b ... 8-byte CRC/ISIZE footer), so
// on a stream we buffer bytes and inflate the member at the head; once its deflate
// stream and footer are both in, that is one message and we drop the consumed bytes.
// This matches the reference clients but MUST be confirmed against real hardware (a
// device that coalesces two messages into one TCP segment is the case to verify).

import zlib from 'node:zlib'

export function encode(obj) {
  // The board ignores the compressed size, so use level 1 (fastest) rather than zlib's
  // default 6 — markedly less CPU per frame on the event loop with no downside on the wire.
  return zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8'), { level: 1 })
}

export function decode(buf) {
  return JSON.parse(zlib.gunzipSync(buf).toString('utf-8'))
}

// How many bytes we will hold while waiting for a member to finish arriving. A board reply is
// a few hundred bytes gzipped and arrives in one or two TCP segments, so a buffer anywhere near
// this is not a slow message — it is one that will never decode.
const MAX_BUFFERED = 64 * 1024
// How long the buffer may hold bytes that yield no message at all before we treat its head as
// garbage rather than as a message still in flight. This catches the small poisoned buffer (a
// ~200 byte truncated member) that the byte cap above never would.
//
// Deliberately NOT a count of push() calls. Node emits 'data' per readable chunk, not per TCP
// segment, so a perfectly good 400-byte reply can arrive in a dozen of them — a chunk-count gate
// decoded zero messages out of exactly that, and the board hangs off hall wifi where slow drips
// are the normal case, not the exception. What a valid reply CANNOT do is sit here undecodable
// past the deadline its own caller waits on, so that is what we measure: 5 s matches send()'s
// default timeout, i.e. we only give up on the bytes once whoever asked for them already has.
const STALL_MS = 5000

// Incremental de-framer for a TCP byte stream. push() returns any fully-decoded
// messages found so far. Member boundaries come from the deflate stream itself: we parse the
// gzip header, inflate the body once, and zlib reports how many compressed bytes it consumed
// before the end-of-stream marker — the 8-byte CRC32/ISIZE footer follows right after.
//
// ONE PER CONNECTION, never one per client: a socket that dies mid-reply leaves a truncated
// member in `buf`, and the next connection's bytes appended behind it are unreachable forever
// (see #resync). The resync below is the backstop for that; a fresh decoder per socket is the
// actual fix, and it lives at the call sites.
export class StreamDecoder {
  // 0 = not stuck. Otherwise the epoch ms at which the buffer started holding bytes that decode
  // to nothing; see STALL_MS.
  #stalledSince = 0

  constructor() {
    this.buf = Buffer.alloc(0)
    // Bumped every time we throw away undecodable bytes. Callers log on a change — a silent
    // resync would hide exactly the incident that motivated it.
    this.resyncs = 0
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    const out = []
    this.#drain(out)
    // Decide, then decode AGAIN in the same call. #resync() used to be the last thing push did,
    // so any reply already complete BEHIND the dropped garbage stayed in the buffer until the
    // next inbound chunk arrived — and on a board that had just gone quiet, that is the chunk
    // that never comes. Every time the backstop fired, the panel stayed deaf for another whole
    // command timeout for no reason: the bytes were sitting right there, decodable.
    if (this.#headIsGarbage(out.length > 0)) {
      this.#resync()
      this.#drain(out)
    }
    return out
  }

  // Pull every complete member out of the head of the buffer into `out`.
  #drain(out) {
    while (this.buf.length >= 18 /* min gzip size */) {
      const resyncsBefore = this.resyncs
      const member = this.#takeOneMember()
      if (!member) {
        // #takeOneMember resyncs by itself when the head isn't gzip at all. Keep decoding rather
        // than returning: the replies behind the junk it just dropped are readable NOW, and
        // waiting for another inbound chunk to look at them is how the board goes quiet.
        if (this.resyncs !== resyncsBefore) continue // #resync always shortens buf, so this ends
        break
      }
      // Consume BEFORE parsing. #takeOneMember has already proven these bytes gunzip, so the
      // only thing that can throw below is a payload that is not JSON — and leaving it at the
      // head of the buffer made that one bad reply permanent: every later push re-decoded it,
      // threw again, and returned nothing, so every following board reply was lost while the
      // process looked perfectly healthy.
      this.buf = this.buf.subarray(member.length)
      if (member.text === null) continue // failed its checksum; see #takeOneMember
      try {
        out.push(JSON.parse(member.text))
      } catch {
        /* not JSON — drop this message and keep the stream flowing */
      }
    }
  }

  // Bookkeeping and verdict in one: are the bytes at the head garbage, or a message still on its
  // way in? Only ever true once the buffer has held undecodable bytes for STALL_MS — a slow
  // arrival, however many chunks it takes, keeps producing messages and so keeps resetting it.
  #headIsGarbage(decoded) {
    if (this.buf.length > MAX_BUFFERED) return true // far past any real reply; see MAX_BUFFERED
    if (decoded || !this.buf.length) { this.#stalledSince = 0; return false }
    if (!this.#stalledSince) { this.#stalledSince = Date.now(); return false }
    return Date.now() - this.#stalledSince > STALL_MS
  }

  // Drop the head of the buffer and restart at the next gzip member.
  //
  // The magic check in #takeOneMember only fires when the head ISN'T `1f 8b`, which is the one
  // case that never happens after a disconnect mid-reply: the stale truncated member starts with
  // a perfectly good `1f 8b`, so the decoder goes deaf for the rest of its life. That surfaced as
  // a board frozen on the last score it was given, with systemd reporting a healthy PID.
  #resync() {
    let at = -1
    for (let i = 1; i + 1 < this.buf.length; i++) {
      if (this.buf[i] === 0x1f && this.buf[i + 1] === 0x8b) { at = i; break }
    }
    this.buf = at === -1 ? Buffer.alloc(0) : this.buf.subarray(at)
    this.#stalledSince = 0
    this.resyncs++
  }

  // Returns { length, text } for the member at the head of the buffer, or null if it has not
  // finished arriving. `text` is null for a member that is complete but fails its CRC/ISIZE
  // check: its extent is known, so it is consumed and dropped rather than left to stall the
  // stream for STALL_MS. Decompresses once and hands the text back, so push() doesn't gunzip
  // the same member a second time — that cost is paid per reply, on a Pi.
  //
  // ONE inflate per call. This used to gunzip every prefix from 18 bytes up to the buffer's
  // length until one decoded, i.e. a reply of n bytes cost n failed decompressions, each
  // allocating an Error — ~7 ms for a 300-byte reply on x86 and 40 ms when it dripped in, on a
  // board that sends one per paint and per blink toggle. inflateRaw stops at the deflate
  // end-of-stream marker on its own and reports how far it read, which IS the member boundary.
  #takeOneMember() {
    if (this.buf[0] !== 0x1f || this.buf[1] !== 0x8b) {
      this.#resync()
      return null
    }
    const start = gzipHeaderLength(this.buf)
    if (start === -1) { this.#resync(); return null } // `1f 8b` by chance, not a gzip header
    if (start === 0) return null // header itself still in flight
    let inflated
    try {
      inflated = zlib.inflateRawSync(this.buf.subarray(start), { info: true })
    } catch {
      return null // truncated (or corrupt — the stall timer tells those apart)
    }
    const end = start + inflated.engine.bytesWritten + 8
    if (end > this.buf.length) return null // body complete, footer not yet here
    const body = inflated.buffer
    const crc = this.buf.readUInt32LE(end - 8)
    const isize = this.buf.readUInt32LE(end - 4)
    // zlib.crc32 is Node >= 22.2; on anything older ISIZE alone still catches most damage.
    const intact = isize === (body.length >>> 0) && (typeof zlib.crc32 !== 'function' || crc === zlib.crc32(body) >>> 0)
    return { length: end, text: intact ? body.toString('utf-8') : null }
  }
}

// Length of the gzip member header at the head of `buf` (RFC 1952 §2.3): 0 when more bytes are
// needed to know, -1 when it is not a deflate gzip header at all.
function gzipHeaderLength(buf) {
  if (buf.length < 10) return 0
  const flags = buf[3]
  if (buf[2] !== 8 || (flags & 0xe0)) return -1 // CM must be deflate; reserved FLG bits must be 0
  let at = 10
  if (flags & 0x04) { // FEXTRA
    if (buf.length < at + 2) return 0
    at += 2 + buf.readUInt16LE(at)
  }
  for (const bit of [0x08, 0x10]) { // FNAME, FCOMMENT: zero-terminated
    if (!(flags & bit)) continue
    const nul = buf.indexOf(0, at)
    if (nul === -1) return 0
    at = nul + 1
  }
  if (flags & 0x02) at += 2 // FHCRC
  return buf.length > at ? at : 0
}

// #ef4444 / ef4444 / rgb(...) -> "r,g,b" (LEDbox colour format). Falls back to white.
export function hexToRgb(color, fallback = '255,255,255') {
  if (!color) return fallback
  const m = String(color).trim().match(/^#?([0-9a-f]{6})$/i)
  if (!m) {
    const rgb = String(color).match(/(\d{1,3})\D+(\d{1,3})\D+(\d{1,3})/)
    return rgb ? `${rgb[1]},${rgb[2]},${rgb[3]}` : fallback
  }
  const n = parseInt(m[1], 16)
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
}
