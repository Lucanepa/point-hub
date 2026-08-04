#!/usr/bin/env python3
"""Regenerate the four boot-splash PNGs the LED panel shows before the bridge is up.

These are NOT layout XML — they are raw framebuffer images. `bin/startledbox` and `bin/startled`
copy one of them over `www/buffer.png` and hand it to `flushBuffer2`, which pushes the bitmap
straight at the matrix:

    bin/startledbox:3   sudo cp bin/start.png    www/buffer.png     # power-on, and on shutdown
    bin/startled:39     cp     starting.png ../www/buffer.png       # panel driver coming up
    (setup.png / error.png are the vendor's install + failure screens)

So this is the very first thing on the panel at power-up, before Python, before the network,
before anything of ours runs — which is why the stock ones still said "LEDbox / www.tech4sport.com"
long after the rest of the board stopped being a Tech4Sport product.

    python3 gen_splash.py                      # -> ./out/{start,starting,setup,error}.png
    python3 gen_splash.py --outdir /tmp/x      # preview elsewhere first

Deploy (keep the vendor originals — they are not in any package):
    ssh ledbox 'cd /home/pi/ledbox/bin && mkdir -p vendor-splash.orig &&
                cp -n start.png starting.png setup.png error.png vendor-splash.orig/'
    scp out/*.png ledbox:/home/pi/ledbox/bin/

Deps: Pillow. The board has no Pillow, so render here and scp the PNGs across.
"""
import argparse
import os

from PIL import Image, ImageDraw, ImageFont

# The panel is 192x64 physical LEDs. flushBuffer2 does no scaling, so anything other than an
# exact 192x64 image is cropped rather than fitted.
W, H = 192, 64

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

# KSC Wiedikon gold — the same 255,200,50 the crest screen paints club names in
# (CLUB_GOLD in src/volleyballMapper.js), so the board is one identity from boot onward.
GOLD = (255, 200, 50)
WHITE = (235, 235, 235)
RED = (255, 40, 40)

BRAND = "POINT HUB"

# One entry per vendor file we are replacing, so the filenames the boot scripts already
# reference keep working untouched. Only the artwork changes.
SCREENS = [
    ("start.png", "KSC Wiedikon", WHITE),
    ("starting.png", "Starting...", WHITE),
    ("setup.png", "Setup...", WHITE),
    ("error.png", "Error!", RED),
]


def fit_font(path, text, max_w, max_h, start=40):
    """Largest size at which `text` fits the given box. Stepped down one point at a time rather
    than solved analytically because TrueType hinting makes the advance width non-linear in size —
    computing it from a ratio overshoots by a pixel or two, and a clipped brand mark looks broken."""
    for size in range(start, 5, -1):
        f = ImageFont.truetype(path, size)
        box = f.getbbox(text)
        if (box[2] - box[0]) <= max_w and (box[3] - box[1]) <= max_h:
            return f, box
    raise SystemExit(f"{text!r} will not fit {max_w}x{max_h}px")


def draw_centered(d, text, font, box, cy, color):
    """Draw `text` horizontally centred, with its INK centred on `cy`.

    getbbox() offsets matter here: at these sizes the difference between positioning by the font's
    nominal origin and by the inked pixels is several LEDs, which on a 64px-tall panel is the
    difference between centred and visibly low.
    """
    w = box[2] - box[0]
    h = box[3] - box[1]
    x = (W - w) // 2 - box[0]
    y = cy - h // 2 - box[1]
    d.text((x, y), text, font=font, fill=color)


def render(subtitle, sub_color, path):
    img = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)

    # Brand on top, subtitle under it — the same two-line shape as the vendor screens, so the
    # board looks re-branded rather than broken to anyone who knew the old one.
    brand_font, brand_box = fit_font(FONT_BOLD, BRAND, W - 12, 40, start=44)
    draw_centered(d, BRAND, brand_font, brand_box, 24, GOLD)

    sub_font, sub_box = fit_font(FONT_REG, subtitle, W - 20, 18, start=16)
    draw_centered(d, subtitle, sub_font, sub_box, 52, sub_color)

    img.save(path)
    return brand_box[2] - brand_box[0], sub_box[2] - sub_box[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)
    for name, subtitle, color in SCREENS:
        bw, sw = render(subtitle, color, os.path.join(a.outdir, name))
        print(f"{name:14} {W}x{H}  brand {bw}px wide, subtitle {subtitle!r} {sw}px")


if __name__ == "__main__":
    main()
