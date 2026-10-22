# flushBuffer2 — open rebuild of the vendor panel driver

`flushBuffer` is the only closed piece left in the stack: an unstripped ARM binary
that pushes `buffer.png` out to the LED panel. This directory rebuilds an equivalent
from open source, so there is **no vendor binary and no legacy-library staging**.

## Why

The vendor `flushBuffer` links `libGraphicsMagick++-Q16.so.12`, which drags in
OpenSSL 1.1 / libtiff5 / libwebp6 — all removed from Debian 12. They are currently
staged in `/home/pi/ledbox/lib` and injected via `LD_LIBRARY_PATH`. `flushBuffer2`
links **only stock bookworm libraries** (`libstdc++`, `libm`, `libc`, `libgcc_s`) —
verified with `ldd`. It also drops the vendor licence check and the GraphicsMagick
round-trip (PNG is decoded with the single-header, public-domain `stb_image`).

## What it is

Henner Zeller's open-source [`rpi-rgb-led-matrix`](https://github.com/hzeller/rpi-rgb-led-matrix)
(the vendor's own build path `/home/pi/flushBuffer/rpi-rgb-led-matrix-master/` is
embedded in their binary) plus:

- the custom **`applicon`** GPIO mapping — stock `regular` with the **E-line on GPIO26**
  instead of GPIO15 (recovered from the vendor binary's debug info); and
- a `main` (`flushbuffer.cc`) that reloads the PNG each frame at ~62 fps, takes its
  brightness **live** from a file on tmpfs (no restart per change — [below](#live-brightness)),
  and has an optional per-frame **power governor** for the DIY build ([below](#power-governor-diy-build)).

The source is ahead of the binary on the board: what runs there is the 2026-08-01 build
(brightness at launch only) until someone rebuilds it at the panel —
[On the board: rebuild and switch over](#on-the-board-rebuild-and-switch-over). Everything
around it (bridge, `startled`, watchdog) works with either binary.

### Effective config (recovered from the unstripped vendor binary via gdb/objdump)

The vendor `main` **compiles in** the geometry and scan mode (they are *not* on its
command line), then lets `--led-*` flags override the rest. `flushbuffer.cc` does the
identical thing:

| setting | value | source |
|---|---|---|
| rows / cols | 64 / 64 | compiled in (`Options` stores) |
| chain_length / parallel | 3 / 1 | compiled in → 64×192 = **192×64** |
| **scan_mode** | **1** | compiled in (easy to miss — no CLI flag) |
| gpio mapping | `applicon` | CLI (`--led-gpio-mapping`) |
| pwm-bits / lsb / dither | 7 / 450 / 2 | CLI |
| multiplexing | 1 | CLI |
| brightness | 40 | CLI |
| gpio slowdown | 5 | CLI (RuntimeOptions) |

## Build

```bash
./build.sh          # fetches PINNED hzeller + stb_image (sha256-checked), patches applicon,
                    # builds $WORK/rpi-rgb-led-matrix-<sha>/flushBuffer2
```

Native armhf build (board has `g++`/`make`). No cross-compiler, no cmake, no
GraphicsMagick-dev. The last line prints `ldd` — confirm only stock libs.

The same script builds on an x86 Linux machine too (`WORK=/tmp/fb ./build.sh`): a compile
check of `flushbuffer.cc` against the pinned library, not a binary for the board.
`node test/flushbuffer-selftest.mjs` (part of `npm test`) goes further off the board: it builds
`flushbuffer.cc` against a stand-in matrix and drives the control files and the governor.
Neither can show the glass.

## Licence: the binary is GPL-2.0-only

`flushbuffer.cc`, `build.sh`, `startled` and `stopled` are MIT like the rest of the repo. The
**built `flushBuffer2` binary is not**: it links hzeller's `rpi-rgb-led-matrix`, which is licensed
under the GPL **version 2 only** (no "or later"), so the binary as a whole is **GPL-2.0-only**.

Building it on the board, as today, distributes nothing. The moment a `flushBuffer2` binary leaves
the club — copied to another club's board, or inside a ready-to-flash SD image — the corresponding
source has to go with it: the `rpi-rgb-led-matrix` tarball at the commit pinned in `build.sh`,
`stb_image.h` at its pinned commit, and `flushbuffer.cc` + `build.sh` from this directory. An SD
image also carries the OS's own source obligations. The third-party list is in the repo's
[`NOTICE`](../../NOTICE).

## ⚠️ Testing — REQUIRES eyes on the physical panel

`flushBuffer2` drives the panel over GPIO. If the geometry/mapping is wrong the panel
shows **garbage**, and that is **invisible over the network** — `buffer.png` (the source
image) still looks perfect. So this can only be verified by someone **looking at the panel**.
Do not skip this. Only one process may own the GPIO at a time.

At the panel:

```bash
# 1. stop the vendor driver (blanks the panel)
sudo killall flushBuffer

# 2. run the rebuild by hand (Ctrl-C to stop)
cd /home/pi/ledbox/bin
sudo ./flushBuffer2 ../www/buffer.png

# 3. LOOK at the panel:
#    - correct  -> proceed to "Integrate" below
#    - garbled  -> Ctrl-C, then roll back (below) and note what you saw
```

### Roll back (panel is wrong, or to return to the vendor driver)

```bash
sudo killall flushBuffer2 2>/dev/null
cd /home/pi/ledbox/bin && sudo ./startled      # restarts the vendor flushBuffer
```

Nothing here modifies the vendor `flushBuffer`, `startled`, or the watchdog, so rollback
is just "run the old driver again."

## Status: ✅ ACTIVE (integrated + panel-verified 2026-08-01)

`flushBuffer2` is the **live** driver on the board — verified on the physical panel
(rendered the same image as the vendor driver, no garble). The vendor `flushBuffer` is
kept in place as an instant fallback but is no longer run, and the `/home/pi/ledbox/lib`
legacy staging is no longer needed by the active path.

The boot scripts as deployed are captured next to this file:

- [`startled`](startled) — launches `flushBuffer2` (no `LD_LIBRARY_PATH`; `--led-*` tuning
  still read from `setting.ini` so brightness/pwm/mux stay editable; geometry + scan_mode
  are compiled in, so no `--led-rows/cols/chain/scan-mode`/`--screen-dimension`). Since
  2026-10-22 it also passes the optional `limit_refresh` and `power_*` keys, only when set
- [`stopled`](stopled) — `killall -q flushBuffer2 flushBuffer`
- the watchdog ([`../ledbox-watchdog.sh`](../ledbox-watchdog.sh)) now monitors `flushBuffer2`

On the board these live at `/home/pi/ledbox/bin/{startled,stopled,watchdog}`; the pre-swap
versions are backed up at `/home/pi/ledbox-config-backup/*.pre-fb2`.
Binary: `/home/pi/ledbox/bin/flushBuffer2`, sha256
`c015440506aed1abac9634029a6302e22bde5ce2b5083234009e8b278bec2c59` — the 2026-08-01 build,
which takes brightness at launch only. The `startled`, watchdog and bridge in this repo work
with it unchanged; the live brightness below needs the rebuild.

### Roll back to the vendor driver

```bash
cd /home/pi/ledbox/bin
sudo cp /home/pi/ledbox-config-backup/startled.pre-fb2 startled
sudo cp /home/pi/ledbox-config-backup/stopled.pre-fb2  stopled
sudo cp /home/pi/ledbox-config-backup/watchdog.pre-fb2 watchdog
sudo systemctl restart ledbox-watchdog
sudo ./stopled && sudo ./restartled            # back on the vendor flushBuffer + LD_LIBRARY_PATH
```

## Live brightness

Brightness used to be a launch flag and nothing else, so each change in the console rewrote
`setting.ini` and killed + relaunched the driver under `panel.lock` (`PANEL_RESTART` in
[`src/panelBrightness.js`](../../src/panelBrightness.js)): a dark gap on every change, and the
source of the two-drivers vertical-flicker races. hzeller's `SetBrightness()` works at runtime,
and this driver re-sets every pixel every frame, so a new level is on the glass one frame after
it is read. The channel is a directory on tmpfs, `/run/ledbox-panel/` (`--ctl-dir=PATH` moves it,
`--ctl-dir=` with nothing after it switches it off):

| file | written by | what |
|---|---|---|
| `brightness` | the bridge (pi) | one number, 0–100, re-read every 6 frames (~100 ms). **0 = black, driver still running.** No file = the `--led-brightness` it was launched with |
| `power` | whoever owns the power budget | `key=value` lines for the governor (below) |
| `driver` | `flushBuffer2` itself, once the matrix is up | `pid=`, `start=` (field 22 of `/proc/<pid>/stat`), `control=brightness power`. Removed on a clean exit |
| `status` | `flushBuffer2`, at most once a second | `requested= shown= cap= budget_ma= duty= est_ma= limited_frames=` |

The directory is created `0777` (no sticky bit) while the driver is still root: hzeller drops it
to `daemon` once the GPIO is open, the bridge writes as `pi`, the watchdog as root, and every
account that can write there can sudo anyway.

**Old and new binary side by side.** The bridge and the watchdog use the live path only when
`driver` names a *running* process with *that* start time. The 2026-08-01 binary never writes the
file, and a killed driver leaves a dead pid behind, so both get exactly the old behaviour:
rewrite `setting.ini` + `PANEL_RESTART`, and for 0 `PANEL_OFF` + stop the driver. The decision is
made per change, so a rebuild or a rollback needs nothing on the bridge side.

On the live path the bridge still writes the new level into `setting.ini` (no restart): it stays
the persisted **start** value for the next boot or watchdog recovery. 0 keeps the last level that
lit the panel there (hzeller refuses `--led-brightness=0`) and raises `PANEL_OFF`, which carries
"off" across a reboot. The watchdog leaves a live driver that is showing 0 running under
`PANEL_OFF`, and stops anything else — an old driver, or a live one that a reboot lit at the
`setting.ini` level.

By hand, as `pi` (so the bridge can still replace the file afterwards):

```bash
echo 70 > /run/ledbox-panel/brightness.tmp && mv /run/ledbox-panel/brightness.tmp /run/ledbox-panel/brightness
cat /run/ledbox-panel/status
```

## Power governor (DIY build)

Off unless a budget is set; the C0270 runs without one. For a build whose panels at full white
can draw more than the supply or a USB-PD charger delivers (three P5 64×64 indoor panels: ~23 A
at 5 V worst case, [`docs/diy-panel/BUILD.md`](../../docs/diy-panel/BUILD.md) §2).

Before each frame is drawn, its current is estimated from the frame itself:

    I = idle_ma + Σ over R,G,B of  <channel>_ma × (that channel's summed duty) / (full duty × pixels)

where *duty* is hzeller's own CIE1931 mapping of the value at the given brightness, cut to the PWM
planes actually shown (LED current follows that, not the raw value: grey 128 at brightness 100 is
~19 % duty). The frame is drawn at the highest brightness at or below the requested one whose
estimate fits `budget_ma`. Down on the very frame that needs it — before it reaches the glass —
and back up no faster than `rise_per_s`; with a budget set at launch the level starts from black
(fade-in), so neither the boot nor a white frame after a dark one is a step load.

| key (`power` file) | flag (`startled` key) | meaning |
|---|---|---|
| `budget_ma` | `--power-budget-ma` (`power_budget_ma`) | what the panel may draw, mA. 0/absent = off |
| `full_white_ma` | `--power-full-white-ma` (`power_full_white_ma`) | calibration: whole panel, full white, brightness 100, minus idle. Split evenly over R/G/B. Default 24000 |
| `red_ma` `green_ma` `blue_ma` | `--power-red-ma` … | the same per channel; overrides the even split |
| `idle_ma` | `--power-idle-ma` (`power_idle_ma`) | the same rail with the panel black. Default 0 |
| `rise_per_s` | `--power-rise-per-s` | how fast it may climb, brightness points/s. Default 50; 0 = no limit |

The `power` file overrides the flags key by key while it exists; delete it to go back to them.
The governor is the last line, not the only one: keep the fuses and the supply's own limits.

**Calibrate** once per build *and per PWM tuning* (bits, lsb, slowdown and limit-refresh change
how much of each frame the LEDs are lit), with a meter on the panels' 5 V feed. Stop the watchdog and the
driver (only one process may own the GPIO), then run the driver by hand on a plain image, with
its own control dir so the live one is not disturbed:

```bash
sudo systemctl stop ledbox-watchdog; (cd /home/pi/ledbox/bin && sudo ./stopled)
python3 -c "from PIL import Image; Image.new('RGB',(192,64),(255,255,255)).save('/tmp/white.png')"
sudo /home/pi/ledbox/bin/flushBuffer2 /tmp/white.png <the board's --led-* flags> --led-brightness=40 --ctl-dir=/tmp/cal &
cat /tmp/cal/status          # duty=<d> : the frame's mean duty at that brightness
# full_white_ma = (I_white - I_black) / d          (I_black: same with a black image = idle_ma)
# a pure red image gives red_ma = (I_red - I_black) / (3 * d)   — likewise green, blue
```

Calibrate at a low brightness (40 = 11 % of full drive) so a weak supply is not tripped doing it.

## Refresh rate: measure, then lock

Nobody has measured this panel's refresh yet (estimate ~90–120 Hz: at slowdown 5 it is limited by
clocking 192 columns per plane). hzeller's README: below ~300 Hz phone video shows dark bands.
`--led-limit-refresh` pads every scan to exactly 1/N s, so a camera shutter spanning a whole
number of scans sees none — but only if N is below the lowest rate the panel really holds.

[`measure-refresh.sh`](measure-refresh.sh), on the board, at the panel:

```bash
sudo ./measure-refresh.sh -t 60                       # the board's flags as they are
sudo ./measure-refresh.sh -t 30 slowdown=4 slowdown=3 # then try what is cheapest first
sudo ./measure-refresh.sh -t 30 lsb=300,brightness=60 lsb=200,brightness=70
```

It reads the running driver's flags, stops the watchdog, holds `panel.lock`, runs the driver by
hand with `--led-show-refresh` once per variant, prints min/avg/max (first 2 s skipped) and the
highest multiple of 100 Hz each run could be locked to, and then puts back exactly what was
running — also on Ctrl-C. It writes nothing of the board's. A run counts only if the panel looked
right during it: short pulses ghost on outdoor panels and a low slowdown garbles, and both show
only on the glass. Lower `bits` only together with more brightness, never at 40 (it drops the low
planes, the only lit ones there). Keep a result by editing `setting.ini` `[DISPLAY]` by hand
(copy the old file first), add `limit_refresh=<lock>` if wanted, and set any new brightness in the
console (it owns `brightness=`). Absent `limit_refresh` = no limit, as today. With a lock at a
multiple of 100 Hz, a 1/100 s or 1/50 s shutter also cancels the hall lights' flicker.

## On the board: rebuild and switch over

**Pending** — nothing below has been done yet. At the panel, someone watching the glass. The bridge
side ([`src/panelBrightness.js`](../../src/panelBrightness.js), shipped by `../../deploy-board.sh`
after `../../drift-check.sh`) works with either binary, so its deploy can come first or last.

```bash
# 0. from the repo: stage the files on the board
ssh ledbox mkdir -p /home/pi/flushbuffer-src
scp firmware/flushbuffer/{build.sh,flushbuffer.cc,startled,measure-refresh.sh} firmware/ledbox-watchdog.sh \
    ledbox:/home/pi/flushbuffer-src/

# on the board, from here on
cd /home/pi/flushbuffer-src

# 1. baseline refresh with the CURRENT binary (optional, but it is the number to beat)
sudo ./measure-refresh.sh -t 60

# 2. build (internet for the two pinned fetches, or drop them into $WORK — see build.sh)
./build.sh                    # last lines: built: /home/pi/flushBuffer-rebuild/rpi-rgb-led-matrix-<sha>/flushBuffer2
                              #             ldd: stock libraries only
NEW=/home/pi/flushBuffer-rebuild/rpi-rgb-led-matrix-51d3231e370593b60952b2c3b18d2e3802329f18/flushBuffer2
sha256sum "$NEW"              # record it in this README

# 3. back up the three files being replaced
B=/home/pi/ledbox-config-backup
sudo cp -a /home/pi/ledbox/bin/flushBuffer2 $B/flushBuffer2.pre-live
sudo cp -a /home/pi/ledbox/bin/startled     $B/startled.pre-live
sudo cp -a /home/pi/ledbox/bin/watchdog     $B/watchdog.pre-live

# 4. swap: watchdog off, driver off, install, driver on
sudo systemctl stop ledbox-watchdog
(cd /home/pi/ledbox/bin && sudo ./stopled)
sudo install -m 755 "$NEW"              /home/pi/ledbox/bin/flushBuffer2
sudo install -m 755 startled            /home/pi/ledbox/bin/startled
sudo install -m 755 ledbox-watchdog.sh  /home/pi/ledbox/bin/watchdog
sudo systemd-run --collect /home/pi/ledbox/bin/startled

# 5. LOOK at the panel: the same picture as before, no garble, no flicker. Wrong -> roll back (below).
cat /run/ledbox-panel/driver /run/ledbox-panel/status    # pid/start, then requested=40 shown=40 cap=off

# 6. live brightness from the console (Settings > Panel brightness), eyes on the panel:
#    40 -> 70   brighter within ~0.1 s, no dark gap; status says requested=70 shown=70
#    70 -> 0    black; `pgrep -x flushBuffer2` still shows ONE driver
#    0 -> 40    back, no gap
journalctl -u ledbox-bridge -n 20 | grep -i brightness   # "panel brightness 70, applied live"

# 7. watchdog back on; give it its 90 s grace + a tick, then brightness 0 again for 2 min:
sudo systemctl start ledbox-watchdog
journalctl -t ledbox-watchdog -n 20     # no "stopping driver" while a live driver shows 0

# 8. refresh: the A/B runs (previous section), then reboot once and check the panel comes up
```

### Roll back (anything wrong on the glass, or at any later point)

```bash
sudo systemctl stop ledbox-watchdog
(cd /home/pi/ledbox/bin && sudo ./stopled)
B=/home/pi/ledbox-config-backup
sudo cp -a $B/flushBuffer2.pre-live /home/pi/ledbox/bin/flushBuffer2
sudo cp -a $B/startled.pre-live     /home/pi/ledbox/bin/startled
sudo cp -a $B/watchdog.pre-live     /home/pi/ledbox/bin/watchdog
sudo rm -rf /run/ledbox-panel                     # optional: the bridge ignores it once no live driver owns it
sudo systemd-run --collect /home/pi/ledbox/bin/startled
sudo systemctl start ledbox-watchdog
```

The bridge needs nothing: with the old binary it finds no live driver and restarts it on each
change, as before. The new `startled` and watchdog also work with the old binary, so putting back
only `flushBuffer2.pre-live` is enough in a hurry. A `setting.ini` changed by a tuning run is
rolled back by restoring the copy made before it.
