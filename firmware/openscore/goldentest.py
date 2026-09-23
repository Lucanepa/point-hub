#!/usr/bin/env python3
"""Golden-image regression test.

Re-renders every screen and checks it still matches the committed reference in golden/.
Catches accidental rendering changes, and once the board's baseline is dialled in on real
hardware it locks that in too. A screen passes if < 0.5% of its pixels differ from golden
(a small tolerance absorbs Pillow anti-aliasing noise across versions).

    python3 goldentest.py            # check against golden/  (exit 1 on any mismatch)
    python3 goldentest.py --bless    # (re)bless the current render as the reference

The render is hermetic: it runs against a scratch copy of layout/ + setting.ini + media/, with
media/wifi_qr.png replaced by fixtures/wifi_qr.DUMMY.png, which encodes the obviously fake
`WIFI:T:WPA;S:TEST;P:not-a-real-password;;`, and the info screen shows a fixed IP instead of
this machine's. Two reasons for the QR, both learned the hard way:
  - the real wifi_qr.png is a secret and gitignored, so a render that used it could only pass on
    the one machine that had it (a clean checkout drew an empty box and failed 00_waiting);
  - blessing that render baked the board's WPA passphrase into golden/00_waiting.png, as an image
    no secret scanner can read. Blessing is therefore only done here, from the fixture — never
    by copying samples/ (which render_samples.py draws with whatever media/ holds).
Regenerate the fixture with idle-crest-qr/gen_qr.py's render() if the QR geometry ever changes.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

try:
    from PIL import Image, ImageChops
except ImportError:
    print("pillow required: pip install pillow")
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
THRESHOLD = 0.005  # max fraction of changed pixels per screen
DUMMY_WIFI_QR = os.path.join(HERE, "fixtures", "wifi_qr.DUMMY.png")
# The info screen prints the host's own IPs; pin them (to the board's AP address) so the golden
# is not tied to whichever machine blessed it — nor publishes that machine's LAN address.
FIXED_IP = "172.24.1.1"
NOISE = 24         # per-pixel r+g+b difference at or below this is anti-aliasing noise


def diff_fraction(a_path, b_path):
    a = Image.open(a_path).convert("RGB")
    b = Image.open(b_path).convert("RGB")
    if a.size != b.size:
        return 1.0
    # Per-pixel r+g+b of the difference, done in Pillow rather than a Python loop over getdata()
    # (deprecated). add() clips at 255, which is harmless: we only ask whether the sum is > NOISE.
    r, g, bl = ImageChops.difference(a, b).split()
    total = ImageChops.add(ImageChops.add(r, g), bl)
    changed = total.point(lambda v: 255 if v > NOISE else 0).histogram()[255]
    return changed / max(1, a.width * a.height)


def build_fixture(root):
    """A firmware dir render_samples.py can use, with no secrets in it."""
    shutil.copytree(os.path.join(HERE, "layout"), os.path.join(root, "layout"))
    shutil.copy(os.path.join(HERE, "setting.ini"), root)
    media = os.path.join(root, "media")
    os.makedirs(media)
    for f in os.listdir(os.path.join(HERE, "media")):
        if f != "wifi_qr.png":  # the real one, if this machine has it, never goes near a render
            shutil.copy(os.path.join(HERE, "media", f), media)
    shutil.copy(DUMMY_WIFI_QR, os.path.join(media, "wifi_qr.png"))


def main():
    ap = argparse.ArgumentParser(description="openscore golden-image test")
    ap.add_argument("--bless", action="store_true",
                    help="overwrite golden/ with the current (fixture) render")
    args = ap.parse_args()

    gdir = os.path.join(HERE, "golden")
    with tempfile.TemporaryDirectory(prefix="openscore-golden-") as root:
        build_fixture(root)
        sdir = os.path.join(root, "samples")
        subprocess.run([sys.executable, os.path.join(HERE, "render_samples.py"),
                        "--base-dir", root, "--out", sdir, "--ips", FIXED_IP],
                       cwd=HERE, check=True, stdout=subprocess.DEVNULL)

        if args.bless:
            os.makedirs(gdir, exist_ok=True)
            for f in sorted(os.listdir(sdir)):
                shutil.copy(os.path.join(sdir, f), os.path.join(gdir, f))
                print(f"  blessed golden/{f}")
            return 0

        golds = sorted(f for f in os.listdir(gdir) if f.endswith(".png")) if os.path.isdir(gdir) else []
        if not golds:
            print("no golden/ reference yet — bless the current render with:  python3 goldentest.py --bless")
            return 1
        ok = True
        for f in golds:
            s = os.path.join(sdir, f)
            if not os.path.exists(s):
                print(f"  FAIL {f}  (not rendered)")
                ok = False
                continue
            frac = diff_fraction(os.path.join(gdir, f), s)
            passed = frac < THRESHOLD
            ok = ok and passed
            print(f"  {'PASS' if passed else 'FAIL'} {f}  ({frac * 100:.2f}% changed)")
        print("golden: OK" if ok else "golden: MISMATCH")
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
