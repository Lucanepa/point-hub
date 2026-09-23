// The reply de-framer: one inflate per member, not one gunzip per byte offset.
//
// StreamDecoder used to find a member's end by gunzipping every prefix of the buffer from 18
// bytes up until one decoded — n failed decompressions (each allocating an Error) for an n-byte
// reply, and n per chunk again when the reply dripped in. Correct, but ~7 ms per 300-byte reply
// on x86 and several times that on the board's ARM, for every paint ack and every blink toggle.
// It now parses the gzip header and lets inflateRaw report where the deflate stream ended.
//
// This pins both halves: the framing stays correct (coalesced, split, dripped, corrupt, garbage),
// and the cost stays O(1) inflates per push.
import zlib from 'node:zlib'
import { encode, StreamDecoder } from '../src/ledboxProtocol.js'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m) } else { fail++; console.log('  ❌', m) } }

// Count decompressions. ledboxProtocol calls through the same default-export object.
let inflates = 0, gunzips = 0
const realInflate = zlib.inflateRawSync, realGunzip = zlib.gunzipSync
zlib.inflateRawSync = (...a) => { inflates++; return realInflate(...a) }
zlib.gunzipSync = (...a) => { gunzips++; return realGunzip(...a) }
const reset = () => { inflates = 0; gunzips = 0 }

const reply = (i, pad = 0) => ({ status: 'ok', sender: 'SetSections', value: { i, pad: 'x'.repeat(pad) } })
// A reply that does not compress to nothing, so it is a few hundred bytes on the wire like a real
// GetSections / Init answer.
const bulky = (i) => ({ status: 'ok', sender: 'GetSections', value: Array.from({ length: 40 }, (_, k) => ({ name: `s${k}`, v: (k * 7919 + i) % 1000 })) })

console.log('one reply, whole:')
{
  const d = new StreamDecoder()
  const frame = encode(bulky(1))
  reset()
  const out = d.push(frame)
  ok(out.length === 1 && out[0].value[3].v === bulky(1).value[3].v, `decoded (${frame.length} bytes)`)
  ok(inflates === 1 && gunzips === 0, `one inflate, no gunzip scan (inflates=${inflates}, gunzips=${gunzips})`)
  ok(d.buf.length === 0, 'buffer fully consumed')
}

console.log('\nthree replies coalesced into one segment:')
{
  const d = new StreamDecoder()
  reset()
  const out = d.push(Buffer.concat([encode(reply(1)), encode(bulky(2)), encode(reply(3, 50))]))
  ok(out.length === 3, 'all three decoded')
  ok(out[0].value.i === 1 && out[1].sender === 'GetSections' && out[2].value.i === 3, 'in order')
  ok(inflates === 3, `one inflate per member (inflates=${inflates})`)
}

console.log('\na reply dripped in 20-byte chunks:')
{
  const d = new StreamDecoder()
  const frame = encode(bulky(4))
  const got = []
  reset()
  let pushes = 0
  for (let i = 0; i < frame.length; i += 20) { got.push(...d.push(frame.subarray(i, i + 20))); pushes++ }
  ok(got.length === 1 && got[0].value[0].v === bulky(4).value[0].v, `decoded once complete (${pushes} chunks)`)
  ok(inflates <= pushes, `at most one inflate per chunk (inflates=${inflates}, chunks=${pushes})`)
}

console.log('\nfooter split from the body:')
{
  const d = new StreamDecoder()
  const frame = encode(reply(5))
  ok(d.push(frame.subarray(0, frame.length - 3)).length === 0, 'nothing yet with the footer short')
  const out = d.push(frame.subarray(frame.length - 3))
  ok(out.length === 1 && out[0].value.i === 5, 'decoded once the footer lands')
}

console.log('\ngzip header with optional fields (FNAME, FEXTRA, FCOMMENT):')
{
  const body = zlib.deflateRawSync(Buffer.from(JSON.stringify(reply(6))))
  const json = Buffer.from(JSON.stringify(reply(6)))
  const footer = Buffer.alloc(8)
  footer.writeUInt32LE(zlib.crc32(json) >>> 0, 0)
  footer.writeUInt32LE(json.length, 4)
  const header = Buffer.concat([
    Buffer.from([0x1f, 0x8b, 8, 0x04 | 0x08 | 0x10, 0, 0, 0, 0, 0, 3]),
    Buffer.from([3, 0, 1, 2, 3]),       // FEXTRA, XLEN 3
    Buffer.from('reply.json\0'),        // FNAME
    Buffer.from('a comment\0'),         // FCOMMENT
  ])
  const frame = Buffer.concat([header, body, footer])
  ok(realGunzip(frame).toString() === json.toString(), '(control: node gunzips it)')
  const d = new StreamDecoder()
  const out = d.push(Buffer.concat([frame, encode(reply(7))]))
  ok(out.length === 2 && out[0].value.i === 6 && out[1].value.i === 7, 'decoded, and the next member after it')
}

console.log('\na complete member with a bad checksum:')
{
  const bad = Buffer.from(encode(reply(8)))
  bad[bad.length - 6] ^= 0xff // flip a CRC byte
  const d = new StreamDecoder()
  const out = d.push(Buffer.concat([bad, encode(reply(9))]))
  ok(out.length === 1 && out[0].value.i === 9, 'dropped at once; the good reply behind it is not held up')
  ok(d.buf.length === 0, 'buffer fully consumed')
}

console.log('\nnon-gzip junk ahead of a reply:')
{
  const d = new StreamDecoder()
  const out = d.push(Buffer.concat([Buffer.from('garbage!'), encode(reply(10))]))
  ok(out.length === 1 && out[0].value.i === 10, 'resynced onto the reply')
  ok(d.resyncs === 1, 'and counted the resync')
}

console.log('\n`1f 8b` that is not a gzip header (wrong method byte):')
{
  const d = new StreamDecoder()
  const out = d.push(Buffer.concat([Buffer.from([0x1f, 0x8b, 0x07, 0, 0, 0, 0, 0, 0, 0, 0, 0]), encode(reply(11))]))
  ok(out.length === 1 && out[0].value.i === 11, 'resynced at once instead of stalling for 5 s')
}

console.log('\ngzip payload that is not JSON:')
{
  const d = new StreamDecoder()
  const out = d.push(Buffer.concat([zlib.gzipSync(Buffer.from('not json')), encode(reply(12))]))
  ok(out.length === 1 && out[0].value.i === 12, 'dropped; the stream keeps flowing')
}

zlib.inflateRawSync = realInflate
zlib.gunzipSync = realGunzip
console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
