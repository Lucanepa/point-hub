#!/usr/bin/env python3
"""Regenerate the idle-screen QR PNGs (wifi_qr.png + ui_qr.png).

The board firmware shows these on the crest idle screen (see waiting.xml /
32_kscw_crest.xml). They are plain 48x48 dark-on-white QR codes. Every module is an exact whole
number of pixels and whatever is left over becomes the quiet zone — the panel
background is dark, so that quiet zone MUST live inside the PNG or scanners lose
the finder-pattern edges. See render() for why the previous stretch-to-fit made
the wifi code unscannable while the UI one was fine.

    python3 gen_qr.py --wifi-pass PASS                    # -> ./media/{wifi,ui}_qr.png
    python3 gen_qr.py --wifi-pass PASS --outdir /tmp/x    # preview elsewhere first

Deps: qrcode + Pillow (`pip install qrcode pillow`). There is NO qrcode lib on
the board, so generate here and scp media/*.png to /home/pi/ledbox/media/.
This script is the encoder the earlier session hand-rolled and did not save.
"""
import argparse
import os

import qrcode
from qrcode.constants import ERROR_CORRECT_H, ERROR_CORRECT_L, ERROR_CORRECT_M, ERROR_CORRECT_Q
from PIL import Image

SSID = "ledbox_C0270"
UI_URL = "http://172.24.1.1:8890"
SIZE = 48       # px, matches width/height in the layout <section type="image">
MIN_QUIET = 2   # px, the smallest white border we will accept around the code


def render(data, path):
    """Draw `data` as a QR whose modules are all EXACTLY the same number of pixels.

    This used to force version 3 at error-correction M and then stretch the matrix across the box
    with `m[(my * n) // avail]`. Two things were wrong with that, and together they are why the
    wifi code would not scan off the panel while the UI one scanned instantly:

      1. The version comment was wrong. 53 bytes is the capacity of v3 at EC **L**; at M it is 42.
         `WIFI:T:WPA;S:ledbox_C0270;P:<18-char passphrase>;;` is 48 bytes, so `fit=True` quietly
         promoted it to version 4 — 33x33 modules, where the UI url stayed at 29x29.
      2. Nearest-neighbour stretching gives modules of UNEVEN width: 33 modules across 42 px comes
         out as a mix of 1 px and 2 px columns. A scanner locates the finder patterns and then
         samples on a regular grid, so an irregular grid is exactly what it cannot read. The
         sparser UI code tolerated the distortion; the denser wifi one did not.

    So: integer scale only, and centre what is left as quiet zone — a generous quiet zone helps a
    scanner, where a stretched module actively hurts it.

    Selection order is (biggest scale, then FEWEST modules, then strongest EC), and the middle term
    is the one that is easy to get wrong. A 48 px box gives 1 px per module for anything from 29 to
    44 modules, so scale alone cannot choose — and picking the strongest error correction on that
    tie lands on EC H at 41x41, which is *worse* than the 33x33 we started from. At one LED per
    module the binding constraint is how many modules the camera has to resolve, not how much
    damage the code can absorb, so fewer modules wins. EC only breaks a tie between equal counts.
    """
    best = None  # (scale, -n, ec_rank) -> bigger is better on every term
    for rank, (ec_name, ec) in enumerate((("H", ERROR_CORRECT_H), ("Q", ERROR_CORRECT_Q),
                                          ("M", ERROR_CORRECT_M), ("L", ERROR_CORRECT_L))):
        qr = qrcode.QRCode(error_correction=ec, border=0)
        qr.add_data(data)
        try:
            qr.make(fit=True)
        except Exception:
            continue                       # too much data for this EC at any version
        m = qr.get_matrix()
        n = len(m)
        scale = (SIZE - 2 * MIN_QUIET) // n
        if scale < 1:
            continue                       # cannot draw a single pixel per module — unreadable
        key = (scale, -n, -rank)           # -rank: H beats L when scale and n are equal
        if best is None or key > best[0]:
            best = (key, scale, n, m, ec_name)
    if best is not None:
        _, scale, n, m, ec_name = best
        best = (scale, n, m, ec_name)
    if best is None:
        raise SystemExit(f"{len(data)} bytes will not fit in a {SIZE}px code — shorten it")

    scale, n, m, ec_name = best
    span = n * scale
    off = (SIZE - span) // 2               # centred; the remainder IS the quiet zone
    img = Image.new("RGB", (SIZE, SIZE), "white")
    px = img.load()
    for my in range(n):
        for mx in range(n):
            if not m[my][mx]:
                continue
            for dy in range(scale):
                for dx in range(scale):
                    px[off + mx * scale + dx, off + my * scale + dy] = (0, 0, 0)
    img.save(path)
    return n, scale, ec_name, off


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wifi-pass", required=True,
                    help="WPA passphrase to encode in wifi_qr.png (must match hostapd.conf). "
                         "Required on purpose — no secret is baked into this script.")
    ap.add_argument("--outdir",
                    default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "media"))
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)
    wifi = f"WIFI:T:WPA;S:{SSID};P:{a.wifi_pass};;"
    for label, data, name in (("wifi_qr.png", wifi, "wifi"), ("ui_qr.png", UI_URL, "ui")):
        n, scale, ec, off = render(data, os.path.join(a.outdir, label))
        # The passphrase is in `wifi`, so never print the payload — only its shape.
        print(f"{label:12} {n}x{n} modules, EC {ec}, {scale}px per module, "
              f"{off}px quiet zone ({len(data)} bytes)")


if __name__ == "__main__":
    main()
