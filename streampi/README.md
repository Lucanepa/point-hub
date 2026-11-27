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

- Raspberry Pi 4 (2 GB is enough): its chip encodes 1080p. A Pi 5 has no H.264 encoder and must do
  it in software (720p likely fine, 1080p to be measured).
- A small case with a heatsink, a 32 GB microSD, a 5 V 3 A USB-C supply or a USB-C power bank.
- A small powered USB hub (the Pi's ports cannot charge the camera for a whole match) and a short
  USB-C to USB-A data cable.
- A clamp or 1/4" plate to hang the box on the camera tripod.

## Set up (once)

```bash
git clone https://github.com/Lucanepa/point-hub && cd point-hub
bash streampi/setup.sh                       # ffmpeg, chromium, node, the service
sudo -u $USER STATE_DIR=/var/lib/streampi node streampi/streampi.js set-pin 2468
```

Then open `http://<pi-name>:8080` on a phone: PIN, the score overlay address, the stream key
(YouTube Studio ▸ Go live ▸ Stream), quality, Save.

## In the hall

1. Camera on fully, USB cable in, tap **Webcam** on the camera.
2. Power the Pi (it joins its Wi-Fi by itself).
3. Phone: `http://<pi-name>:8080` ▸ **Start stream**. The page shows camera, sound, overlay, fps
   and Mbit/s; it says what is wrong when something is (no camera, overlay not reachable, the
   platform refused the stream).

The score overlay address:

| Score from | Address | Needs |
|---|---|---|
| The LedBox, network cable from the Pi to the board | `http://192.168.5.1:8890/overlay` | a cable (up to 100 m); no internet for the score |
| The LedBox over Tailscale | `http://openvolley:8890/overlay` | Tailscale on the Pi |
| OpenVolley (any scorer) | `https://livescore.openvolley.app/board?overlay#ABCD2345` or `…#12345` | the scorer online |

The LedBox page takes `?corner=tl|tr|bl|br` and `?scale=1.5` (see the main README).

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

Not checked yet: a Raspberry Pi (Pi 4 hardware path, Pi 5 CPU), a real YouTube stream, a whole
match on battery.
