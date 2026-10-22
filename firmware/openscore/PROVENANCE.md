# openscore — provenance

Where openscore comes from: who wrote it, from what, and where its layouts come from. Earlier
versions of `README.md` and `DESIGN.md` called openscore a "clean-room"
implementation written without reading any vendor code. That was not accurate, and this page
replaces it.

## In one paragraph

`openscore.py` is an **independent re-implementation** of the Tech4Sport LedBox renderer, written
by this project's maintainer. It is **not a two-team clean room**: the same maintainer had seen the
vendor's code before writing it, because they decompiled the vendor firmware to recover the board
(below). **No vendor code was copied, translated or ported into openscore.** Its structure — the
gzip stream decoder, the layout/section model and XML loader, the Pillow renderer, the flat
command table, the single-client server — was designed for this project. The **layouts** it
ships are written for this project too; Tech4Sport's own layout files are not shipped
([Layouts](#layouts)).

## Timeline

| When | What |
|---|---|
| 2026-07-31 | A vendor update bricked the KSC Wiedikon board. To recover it, the maintainer decompiled the vendor's 0.550 `.pyc` files and ported them to Python 3 ([`../RECOVERY.md`](../RECOVERY.md)). That port runs on the board; it is kept privately and is **not** in this repository. |
| afterwards | Tech4Sport supplied its genuine 0.551 source. The private port was reconciled against it, which produced the 0.552 build the board runs today ([`../CHANGELOG-0.552.md`](../CHANGELOG-0.552.md) lists the differences, not the code). |
| 2026-08-02 | openscore published in this repository's initial public release (commit `2fc90e9`). |
| since | Every change is in the open history: `git log -- firmware/openscore`. |

## What it was written from

- **The protocol as observed**: [`../../PROTOCOL.md`](../../PROTOCOL.md) — traffic on the wire,
  the board's replies and error codes, and the command vocabulary of the vendor's Android app.
- **This repository's own client code**: `src/ledboxProtocol.js`, `src/ledboxClient.js`,
  `src/volleyballMapper.js`, `src/mockLedbox.js`.
- **Layout XML files** — at first the stock volleyball layouts backed up off the board (see
  [Layouts](#layouts) for what is shipped now) — and the open panel driver in
  [`../flushbuffer/`](../flushbuffer/).
- **The real board's behaviour**: the `:8889` wedge after a client dies, the `noresend` stall,
  the error codes and shapes.
- **What the maintainer knew of the vendor code from the recovery.** Two statements in these docs
  come from it directly: that the vendor's layout scanner does `filename, extension =
  f.split('.')` and hangs on multi-dot filenames (first written up in
  [`../idle-crest-qr/README.md`](../idle-crest-qr/README.md)), and that the vendor draws text with
  the board's `ARIAL.TTF` through Pillow's `ImageFont.truetype`. Both are facts about behaviour,
  used to stay compatible and to avoid the bug; no code came with them.

## What was not used

- No vendor source file — decompiled or original — was copied, translated or used as a template
  for `openscore.py`, its tests or its sample renderers.
- No vendor binary is in this directory. The panel driver is `flushBuffer2`, rebuilt from the open
  `rpi-rgb-led-matrix` library ([`../flushbuffer/README.md`](../flushbuffer/README.md)).
- No vendor font. The bundled font is Liberation Sans ([`fonts/README.md`](fonts/README.md)).

Open item: no automated similarity check has been run yet. Comparing `openscore.py` against the
private port with a tool such as JPlag or copydetect, and recording the result here, would back the
"nothing copied" statement with evidence.

## Layouts

**Only layouts written for this project are shipped.** Until October 2026 the repository carried
copies of Tech4Sport's stock layouts (the `volleyball_matchscore_02` family, backed up off the
board), and openscore was first developed against them. On 2026-10-22 they were removed and
replaced by layouts authored here; Tech4Sport's own layout files are no longer in the repository.

What the replacements keep is the **interface**: the section names (`team1`, `score1`, `set1`,
`timeout1`, `sub1`, `serve1`, …) and layout names that the bridge, the vendor's app and the board
all share. Any compatible renderer has to use them, and keeping them is what lets the unchanged
bridge drive both openscore and a stock board. The geometry, colours and defaults in the files are
our own.

Two files in the board's `layouts/` directory were written here but still follow the vendor's
geometry: `20_openvolley_timeout.xml` puts its score and set block at the vendor countdown's x
positions and box sizes, and `40_beach_matchscore.xml` is modelled on the vendor's match layout.
Neither holds vendor text or images; both are due to be redrawn like the volleyball family.

Everything else in this directory is the project's own as well: the KSC Wiedikon idle, crest,
break and `system/waiting` screens, the beach and basketball layouts, the club crest in `media/`
and the QR codes generated by [`../idle-crest-qr/gen_qr.py`](../idle-crest-qr/gen_qr.py). The
repository's third-party list is in [`NOTICE`](../../NOTICE).
