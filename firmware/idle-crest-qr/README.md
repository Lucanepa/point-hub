# Crest + QR idle screen (board firmware layouts)

The board's idle/resting screen: the KSC Wiedikon crest, flanked by a **"Join WiFi"** QR
(left) and an **"Open UI"** QR (right). These live on the **board firmware**, not the bridge.

There are **two** crest screens and the bridge picks between them (`ledboxClient.showIdle`):

| Screen | When | Why |
|---|---|---|
| `kscw_crest` | nobody on the control UI | The QRs are instructions for getting connected. |
| `kscw_clock` | an operator is on the control UI | Once they're connected the QRs are dead space, so it carries the wall clock instead. |

"Connected" = the control server saw an API request within `viewerTimeoutMs` (20s; the UI polls
every 1.5s). Both are the *no-teams-known* screen — once teams are set, `kscw_idle` already uses
that side of the panel for their names.

Where they go on the board (`pi@192.168.5.1`, via the `openvolley` jump host):

| File here | Board path |
|---|---|
| `waiting.xml` | `/home/pi/ledbox/layout/system/waiting.xml` — firmware default idle |
| `32_kscw_crest.xml` | `/home/pi/ledbox/layout/32_kscw_crest.xml` — crest + QRs (nobody connected) |
| `33_kscw_clock.xml` | `/home/pi/ledbox/layout/33_kscw_clock.xml` — crest + wall clock (someone connected) |
| `media/wifi_qr.png` | `/home/pi/ledbox/media/wifi_qr.png` |
| `media/ui_qr.png` | `/home/pi/ledbox/media/ui_qr.png` |

## `kscw_clock` geometry (192×64)

Crest at x=3 y=4, 53×56 — the same placement as `kscw_idle`. The remaining column is x=64..192
(128px), with both text sections centred on x=128:

| Section | Font | Content | Measured width |
|---|---|---|---|
| `time` | 28, white | `HH:MM:SS` | 109px |
| `date` | 14, club gold | `Ddd DD.MM.YYYY` | ≤95px |

Widths were measured against the board's own `/home/pi/ledbox/fonts/ARIAL.TTF` using the same
call the firmware makes (`ImageFont.truetype(font, fontsize)`, width = `getbbox(text)[2]`), so
they are what the panel actually draws. Both are comfortably inside the 128px column; the date
is a fixed 14 characters, so no weekday or date can outgrow it.

The bridge writes `time`/`date` once a minute (only on an actual rollover), never per second.

> The board has **no RTC**. Its clock is only right because it reaches the internet through the
> `openvolley` Pi — see `ledbox-nat.service` on that Pi. If that NAT rule is missing the panel
> will happily display a confidently wrong time.

Both idle layouts carry the QRs so the crest+QR screen shows whether the firmware's own
`waiting` layout or the bridge's `kscw_crest` layout is active. Already deployed; persists
across power cycles. Kept here for versioning / restore.

QR contents:
- `wifi_qr.png` = `WIFI:T:WPA;S:ledbox_C0270;P:<AP passphrase>;;` — **NOT in git, and must never be.**
  The image *is* the passphrase: anyone who points a phone at it has the credential, so committing
  it to this public repo published the board's AP. (It was, until 2026-08-04; the passphrase has
  since been rotated and the file gitignored.) It is derived, not source — regenerate it:
  ```bash
  python3 gen_qr.py --wifi-pass "$(rbw get 'LedBox - ledbox_C0270 WiFi (Tech4Sport)')"
  ```
  The passphrase itself lives in Vaultwarden and in `/etc/hostapd/hostapd.conf` on the board;
  those two must match or the QR joins nothing.
- `ui_qr.png` = `http://172.24.1.1:8890` (no secret — safe to commit)

Regenerate both with `gen_qr.py` (needs `qrcode` + `pillow`). Labels are `<section type="text">`
above each image in the two layouts.

**Do not go back to stretching the matrix to fill the 48×48 box.** It used to force version 3 at
error-correction M and then scale with `m[(my * n) // avail]`, which produced modules of uneven
width — a mix of 1 px and 2 px columns. A scanner finds the finder patterns and then samples on a
regular grid, so an irregular one is precisely what it cannot read. Worse, the version comment was
wrong (53 bytes is v3 at EC **L**; at M it is 42), so the 48-byte wifi payload was silently
promoted to version 4 — 33×33 modules of that distortion. Symptom in the hall: the UI code scanned
instantly and the wifi code would not scan at all. Verified with OpenCV's decoder, at 4×/6×/10×/16×
magnification: every old render failed, every new one decoded.

`render()` now uses whole-pixel modules only and centres the remainder as quiet zone, choosing
(biggest scale, then FEWEST modules, then strongest EC). The middle term matters — at 48 px
everything from 29 to 44 modules scales to 1 px, so ranking on EC alone lands on H at 41×41, worse
than where we started. Today that yields wifi 29×29 EC L with a 9 px quiet zone, and ui 25×25 EC M
with 11 px. A longer passphrase pushes the wifi code up a version, so re-run this and re-check the
reported module count after any rotation.

## Restore after a firmware reflash
```bash
J="-J openvolley -o StrictHostKeyChecking=accept-new"
# wifi_qr.png is gitignored, so a fresh clone has to rebuild it first (see "QR contents" above).
python3 gen_qr.py --wifi-pass "$(rbw get 'LedBox - ledbox_C0270 WiFi (Tech4Sport)')"
scp $J media/wifi_qr.png media/ui_qr.png pi@192.168.5.1:/home/pi/ledbox/media/
scp $J waiting.xml       pi@192.168.5.1:/home/pi/w.xml
scp $J 32_kscw_crest.xml pi@192.168.5.1:/home/pi/c.xml
scp $J 33_kscw_clock.xml pi@192.168.5.1:/home/pi/k.xml
ssh $J pi@192.168.5.1 'sudo cp /home/pi/w.xml /home/pi/ledbox/layout/system/waiting.xml
  sudo cp /home/pi/c.xml /home/pi/ledbox/layout/32_kscw_crest.xml
  sudo cp /home/pi/k.xml /home/pi/ledbox/layout/33_kscw_clock.xml
  rm -f /home/pi/w.xml /home/pi/c.xml /home/pi/k.xml
  PID=$(pgrep -f "[l]edbox\.py" | head -1); [ -n "$PID" ] && sudo kill "$PID"'  # watchdog respawns it
```

Note the staging via `/home/pi/*.xml`: the layout tree is scanned with `f.split('.')`, so a file
must be copied in under its final single-dot name — see the warning below.

## ⚠️ CRITICAL
Never leave a backup file (e.g. `waiting.xml.bak`) **inside** `/home/pi/ledbox/layout/`.
The firmware's layout scanner does `filename, extension = f.split('.')`, which throws on any
multi-dot filename and hangs the board at **"starting…"**. Keep backups **outside** the layout
tree (e.g. `/home/pi/ledbox-layout-backups/`).
