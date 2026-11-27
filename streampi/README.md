# Stream Pi

A small computer next to the camera that sends the match to YouTube (or Twitch, Facebook, any
RTMP server) with the board's scorebug laid over the picture. The board keeps driving its panel;
the camera can stand anywhere.

```
DJI Osmo Action 6 ──USB (Webcam mode: picture + microphone)──► Stream Pi ──Wi-Fi──► YouTube
                                                                  ▲
the LedBox's /overlay (cable or Tailscale), or OpenVolley's ──────┘
/board?overlay#<code or game number>, drawn by headless Chromium
```

Why not the camera's own Wi-Fi: DJI Mimo's live mode needs the camera to join a network, and the
Action 6 found none (26.11.2026, even a plain 2.4 GHz one). USB Webcam mode works on Linux as a
standard camera (UVC 1.50, H.264 up to 4K, MJPEG up to 1080p) and charges the camera too.

## What to buy

- Raspberry Pi 5 (4 GB; 2 GB should do) with the Active Cooler. It has no H.264 encoder, so
  ffmpeg encodes in software: measured 27.11 on a Pi 5 at about 2.1–2.4 of its 4 cores for
  camera-like 1080p (see Checked). A Pi 4 is 2–3× slower: only its hardware encoder could do
  1080p, and that path is untested.
- A small case that fits the cooler, a 32 GB microSD, the 27 W Pi 5 USB-C supply or a USB-C PD
  power bank.
- A small powered USB hub (the Pi's ports cannot charge the camera for a whole match) and a short
  USB-C to USB-A data cable.
- A clamp or 1/4" plate to hang the box on the camera tripod.

## Set up (once)

```bash
git clone https://github.com/Lucanepa/point-hub && cd point-hub
bash streampi/setup.sh --tailscale --wifi       # + the hall networks: SCHULEN_KTZH, KSCW_eScoresheet, Luca_Hotspot
sudo -u $USER STATE_DIR=/var/lib/streampi node streampi/streampi.js set-pin 2468
```

Then open `http://<pi-name>:8080` on a phone: PIN, the score overlay address, the stream key
(YouTube Studio ▸ Go live ▸ Stream), quality, Save.

## Match day

**At home, the day before**
- [ ] Power bank charged (the display shows 100).
- [ ] Osmo battery charged; a microSD in the Osmo if you also want to record.
- [ ] YouTube Studio ▸ Go live ▸ Stream: the visibility (Unlisted for youth teams) and the title set.

**In the hall, 20 minutes before**
1. Tripod up, the box on it, the Osmo clicked onto the lid, the camera cable plugged into the Osmo.
2. Flat network cable from the box's LEDBOX socket to the LedBox's network socket.
3. Power bank into the shelf, its cable into POWER. The Pi starts (about 30 s).
4. Osmo on fully, tap **Webcam** on its screen ("Webcam" shows at the bottom).
5. Phone: `http://streampi:8080` (same Wi-Fi, or over Tailscale) ▸ **Picture: Test pattern** ▸
   **Start stream**. Check in YouTube Studio that the test arrives, then **Stop**.
6. **Picture: Camera** ▸ Save ▸ **Start stream**. Check the score bug in YouTube Studio's preview.

**What the page says**

| Status | Meaning | Do |
|---|---|---|
| Live · 30 fps · 4.5 Mbit/s | on air | nothing |
| Waiting for the camera: "No camera" | the Pi sees no camera | Osmo on, cable in, tap Webcam |
| Score overlay: Not reachable | no score from the LedBox | network cable in at both ends, LedBox on |
| Trying again: "… Connection refused / I/O error" | YouTube refused or no internet | Wi-Fi ok? stream key right? live streaming enabled on the channel? |
| Picture far below 30 fps | the Pi or the camera can't keep up | Quality ▸ 720p |
| The page does not answer | phone and Pi not on the same network | same Wi-Fi, or Tailscale on the phone |

**After the match:** Stop on the page, unplug the power bank, charge it.

Any camera works that a laptop sees as a webcam (the Osmo Action 4/5/6, most action cams and USB
webcams); a camera with only HDMI out needs an HDMI-to-USB capture dongle. The Pi takes H.264,
else MJPEG, else raw video, at 1080p or the biggest size below it (scaled up).

## Wi-Fi

`setup.sh --wifi` saves the hall networks, best first: **SCHULEN_KTZH** (WPA2-Enterprise, the
school login; careful: wrong details lock that account for up to 8 hours), **KSCW_eScoresheet** (the
club router), **Luca_Hotspot**. The console page shows the current network and the saved list,
scans, joins any other network (open or with a password; it lands at position "15", below the
hotspot), connects a saved one, moves one up, forgets one. The Pi moves up to a better saved
network in range every 2 minutes, but never during a stream, and the page refuses Wi-Fi changes
while streaming. Never join the LedBox's own Wi-Fi (ledbox_C0270): it has no internet.
Free_WLAN_KTZH (Swisscom, SMS login page) is not supported yet.

## Score: the LedBox first, OpenVolley as backup

- **A (default): the hall LedBox over Tailscale**, `http://ledbox-c0270:8890/overlay`: the LedBox's
  own scorebug, for every kind of match. Needs Tailscale on the Pi (`setup.sh --tailscale`) and
  internet on both boxes.
- **B (backup): OpenVolley's online scorebug** for the game number or scoreboard code typed on the
  page, used when A doesn't answer; the Pi checks every 2 minutes and goes back to A. Needs the
  scorer online, and OpenVolley PR #357 live.
- A network cable to the LedBox (`http://192.168.5.1:8890/overlay`) still works, as an option.

## YouTube title (optional)

When the stream goes live the Pi renames the YouTube broadcast after the game, for example
"KSCW H1 – Volley Zürich · 28.11.2026", with the names from the LedBox (A) or OpenVolley (B). Set
up once, on the club's Google account:

1. YouTube Studio ▸ Go live ▸ Stream: use the default stream key, turn on **Auto-start** and
   **Auto-stop**, set the default title and visibility (Unlisted).
2. [Google Cloud console](https://console.cloud.google.com/): new project ▸ enable **YouTube Data
   API v3** ▸ OAuth consent screen (External, add the club account as a user, then **publish** it:
   in "Testing" Google drops the permission after 7 days) ▸ Credentials ▸ OAuth client ID ▸ type
   **TVs and Limited Input devices**. Copy the client ID and secret.
3. Stream Pi page ▸ YouTube title: tick the box, paste the ID and secret, **Connect YouTube**, then
   open the address shown on a phone and type the code, signed in with the club account.

The page's "YouTube title" line shows the title once it is set. Without names (no match on the
LedBox yet) the Pi keeps trying every 30 s for 20 minutes.

The other score overlay addresses:

| Score from | Address | Needs |
|---|---|---|
| The LedBox, network cable from the Pi to the board (**the default**) | `http://192.168.5.1:8890/overlay` | a cable (up to 100 m); no internet for the score. The LedBox gives the Pi an address on the cable but no internet route, so the stream keeps using Wi-Fi |
| The LedBox over Tailscale | `http://openvolley:8890/overlay` | Tailscale on the Pi |
| OpenVolley (any scorer) | `https://livescore.openvolley.app/board?overlay#ABCD2345` or `…#12345` | the scorer online |

The LedBox page takes `?corner=tl|tr|bl|br` and `?scale=1.5` (see the main README). Only that
corner of the frame (half the width, 45 % of the height) is captured and blended, which saves a
Pi a lot of work; for a big `?scale=` or a page that draws elsewhere set `OVERLAY_REGION=full`.

**Test pattern** (Picture ▸ Test pattern) streams a moving test picture instead of the camera: use
it to check the stream key and the hall's upload before the match.

## Run it elsewhere (a laptop, a test)

```bash
cd streampi && npm install
STATE_DIR=/tmp/sp CONTROL_PORT=8080 node streampi.js set-pin 2468
STATE_DIR=/tmp/sp CONTROL_PORT=8080 CHROME_PATH=/usr/bin/google-chrome node streampi.js
# a file instead of a platform, 30 s: add OUTPUT=/tmp/test.mkv DURATION=30
npm test                                       # the selftest (no camera, no ffmpeg)
```

## Checked (27.11.2026, lenovoserver, x86)

- Test pattern + the board's real `/overlay` (`MOCK=1` appliance) for 40 s, started and stopped
  through the console's API: 30 fps, 0 dropped, 4.3 Mbit/s, 1,200 distinct frames; points, the
  time-out countdown and its end all appear in the video.
- 26.11 on fw13 with the real Osmo: picture, the camera's microphone and the overlay in one file,
  but the frame rate sank (12 → 5 fps). Fixed since by stamping every input with the wall clock and
  a steady `fps=` on the camera; the real camera has not been tried again yet.

- 27.11 on the MINI's Pi 5 (4 GB, Active Cooler), next to the board's own services (~1.2 cores):
  the Stream Pi with the test pattern + the real `/overlay` held 30 fps, 0 dropped at 1080p and
  720p; the whole Pi at ~76 % (1080p, corner crop) and ~50 % (720p). With a camera-like 1080p
  H.264 clip as input, ffmpeg alone needed 2.1–2.4 cores and reached 0.92–0.96× real time beside
  the board's services; a Pi 5 that only streams should keep up (to confirm). Max 60 °C, never
  throttled.

Not checked yet: a dedicated Stream Pi (1080p in real time with the real camera), the Pi 4
hardware path, a real YouTube stream, a whole match on battery.
