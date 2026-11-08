# Setting up a Point Hub board

The Pi 5 side of [docs/diy-panel/BUILD.md](../../docs/diy-panel/BUILD.md). The C0270 uses none of this.

**Written before the parts arrived, and not yet run on the real board.** The logic is tested against
simulated chips and a mock panel; the bench list below is what only the real board can answer.

## What runs

```
OpenVolley or console on the 10-inch screen (pointhub-screen)
   │ relay on :8080 and :5173, or the console's own game
ledbox-bridge: console on :8890, follows the match ──TCP 8889──▶ pointhub-openscore: draws buffer.png
   │ reads hw.json, sets the lights                                  │
pointhubd: I2C bus, power budget, thermal cut-off, horn ──power──▶ pointhub-led: flushBuffer2 ──▶ 8 modules
```

## Steps

1. **On a laptop, before the card's first boot:** flash Raspberry Pi OS Lite 64-bit with a current
   Imager, then `sudo ./prepare-card.sh /dev/sdX`. This makes the `/data` partition for settings,
   match history and the OpenVolley data. The script refuses a non-removable disk and asks first.
2. **On the Pi:** clone this repo, then `sudo provisioning/point-hub/setup-board.sh`, then reboot.
3. **Check the small boards:** `/opt/pointhub/pointhubd.py probe`.
4. **OpenVolley on the screen:** the screen starts by asking Point Hub or OpenVolley eScoresheet.
   Put the arm64 `.deb` from the "Build Desktop App" workflow (manual run, artifact
   `escoresheet-desktop-linux-arm64`) in the repo folder before step 2, or `sudo apt install` it
   afterwards. Until then the start screen offers only Point Hub.
   It is a workflow artifact, not on APT: a release has one amd64 `.deb`, and APT stays amd64.
5. **Last, before any hall use:** `sudo ./enable-readonly-root.sh`, reboot, and the security list.

## Bench list: what only the real board can answer

| Check | How | If it fails |
|---|---|---|
| Parts on the bus, `dtparam=i2c_vc=on` is right for the Pi 5 | `pointhubd.py probe` | Overlays README on the image; `PH_I2C_BUS` |
| I2C works while the LEDs run | probe with `pointhub-led` running, watch for flicker | The Pi 5 pin plan (BUILD.md section 4.2) |
| Horn silent at boot, sounds, stops | power up; `pointhubd.py ctl horn 600` | AOD4184 module's terminals |
| PD contract reads right | a 65 W and an 18 W charger; `pointhubd.py ctl status` | RDO parsing in `parse_rdo` |
| Driver runs as `pi`, on Trixie | `journalctl -u pointhub-led` | `/dev/pio0` group, `--led-no-drop-privs` |
| Colours, order, bench rotation | Diagnostics > Show test screen | `rgb_sequence`, ribbons, `bench_*_rotate` |
| Self-test finds a pulled fuse | pull one module's fuse, Run self-test | `settleMs` in `boardHardware.js` |
| Text sits right on the glass | look at the score; openscore's text is about 4 px high (ROADMAP Phase 2) | Placement in `Renderer._draw_text` |
| Budget matches reality | full white under a USB-C meter (BUILD.md section 5.5) | `PH_FULL_WHITE_MA`, `PH_IDLE_MA` |
| Screen does not make the LEDs flicker | BUILD.md section 10.4 (passed on the bench 08.11, both screens) | The screen stays out |
| Backup copy, plugged in and pulled mid-match | a FAT32 stick in each port; Diagnostics > Board health; check `OpenVolley/` on it | `journalctl -u 'pointhub-backup-stick@*'` |
| Stick in the blue USB 3 port does not disturb hall Wi-Fi or the LEDs | stick copying, watch LINK and the panel | a shielded cable, or the USB 2 port |
| OpenVolley runs and follows | start a match on the screen, score a point | `journalctl -u pointhub-screen`, Diagnostics |
| On-screen keyboard appears in both apps | tap a text field | `squeekboard`, `--enable-wayland-ime` |
| Tablet on the cable reaches the referee page | `http://192.168.5.1:5173/referee` | `ETH0_EXTRA_PORTS` |

## The screen

The scorer's screen is a **MINIX SF16T** (16", 1920 x 1200, touch over USB) on HDMI, chosen on the
bench 08.11 over the Waveshare 10.1" DSI screen; `pointhub-screen` still runs either.

- **HDMI port:** the one next to the Pi's USB-C power socket. On the other one it read no EDID.
- **Resolution:** its own 1920 x 1200 at 60 Hz (it offers 120 Hz first), and the pages are enlarged
  instead: `OPENVOLLEY_ZOOM` for OpenVolley, `--force-device-scale-factor` for Chromium. A compositor
  scale of 1.5 made GTK 3 draw at 2 and labwc shrink it, soft and slower. Needs OpenVolley with
  `OPENVOLLEY_ZOOM` (openvolley#75).
- **OpenVolley's picture** is scrambled on both screens with WebKit's default renderer;
  `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` makes it clean.
- **On-screen keyboard:** `squeekboard/` holds layouts with a key that closes the keyboard (F20; the
  pages close it on that key). Raspberry Pi's squeekboard reads only `/usr/share/misc/squeekboard/keyboards`
  unless `SQUEEKBOARD_KEYBOARDSDIR` is set, so `pointhub-screen` copies that set and lays ours over it.
- **The MINIX itself:** it comes back on by itself after a power cut (only its very first start needed
  its button), runs on plain 5 V at full brightness, and shows its own logo for about 4 s at power-up
  (no setting turns it off). Its brightness can be set from the Pi over DDC/CI (`/dev/i2c-13` with
  `i2c-dev` loaded, VCP 0x10); it came at 50.

## Still open

- **STUSB4500 NVM** (`power_above_5v_only`, the PDOs, BUILD.md section 5.2) is not programmed by anything
  here. It has limited write cycles and a wrong write is hard to undo, so it waits for the real chip.
- **Live match on read-only root:** run the soak test (2 h at the power cap) with it on.
- **Updating a board** with a read-only root means turning it off first (see `enable-readonly-root.sh`).
  OpenVolley's in-app updater has no arm64 build to offer, so it stays at the installed version.

## Security list before any hall use

Remove the bench's passwordless sudo (`/etc/sudoers.d/010_pi-nopasswd`; `020_pointhub` stays), change
the Pi password, and remove the laptop's bench key.
