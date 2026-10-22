#!/usr/bin/env python3
"""
render_samples.py — drive the openscore Device through every screen the bridge uses and
save a PNG of each, so the renderer can be eyeballed with NO panel and NO bridge.

It feeds the Device the same {cmd,value} messages the bridge sends over the wire (SetLayout +
the one-attrib-per-entry SetSections WRITE shape), then copies each composed www/buffer.png to
samples/<name>.png. Run:  python3 render_samples.py   (needs Pillow)

--base-dir renders from another firmware dir (layout/, media/, setting.ini) and --out writes the
PNGs elsewhere; goldentest.py uses both to render against a fixture instead of this checkout.
"""
import argparse
import os
import shutil

import openscore as olb

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "samples")

# KSCW blue vs a warm orange opponent, matching the layouts' default team colours.
BLUE = "37,99,235"
ORANGE = "255,69,0"


def attr(name, a, v):
    """The LedBox SetSections WRITE shape: one {attrib,value} per entry (per PROTOCOL.md)."""
    return {"name": name, "value": {"attrib": a, "value": str(v)}}


def text(name, v, color=None):
    out = [attr(name, "text", v)]
    if color:
        out.append(attr(name, "color", color))
    return out


def box(name, color):
    # black fill so a big number reads; border in the team colour (bordercolor is real).
    return [attr(name, "color", "0,0,0"), attr(name, "bordercolor", color)]


def rect(name, color):
    return [attr(name, "color", color)]


def scoreboard():
    return (
        # Short codes on the match screen, exactly as the bridge paints it (full names are
        # reserved for the width-fitted crest idle screen).
        text("team1", "WIEDIKON", BLUE) + text("team2", "VOLZ", ORANGE)
        + text("score1", 18, BLUE) + text("score2", 16, ORANGE)
        + box("bg_score1", BLUE) + box("bg_score2", ORANGE)
        + text("set1", 1, BLUE) + text("set2", 1, ORANGE)
        + [attr("vs", "text", "-")]
        + text("timeout1", 1, "200,200,200") + text("timeout2", 2, "170,0,20")
        + text("sub1", 3, "200,200,200") + text("sub2", 6, "170,0,20")
        + rect("serve1", BLUE) + rect("serve2", "30,30,30")
    )


def break_screen():
    return (
        [attr("lbl", "text", "TIME OUT"), attr("team", "text", "WIEDIKON"),
         attr("timer", "text", "0:22"), attr("timerbig", "text", "")]
        + text("score1", 18, BLUE) + text("score2", 16, ORANGE)
        + text("set1", 1, BLUE) + text("set2", 1, ORANGE)
        + box("bg_score1", BLUE) + box("bg_score2", ORANGE)
    )


def countdown():
    # The bridge's fallback countdown (toCountdownSections, a timeout): points in the boxes, the
    # set score on the line below the clock.
    return (
        [attr("timer", "text", "30"), attr("lbl", "text", "TO WIEDIKON"), attr("sep", "text", "-")]
        + text("score1", 18, BLUE) + text("score2", 16, ORANGE)
        + text("set1", 1) + text("set2", 1)
        + box("bg_score1", BLUE) + box("bg_score2", ORANGE)
        + [attr("media", "src", "")]  # the bridge blanks `media` on every countdown
    )


def shapes():
    """The section types no bridge screen uses (circle, bar), plus the text ladder either side of
    SMALL_TEXT_PX, drawn as an ad-hoc layout so they stay covered without a layout file for them.
    Small text must come out as whole pixels in one colour; big text keeps its anti-aliasing."""
    S = olb.Section
    return olb.Layout(name="__shapes__", sections=[
        S(name="dot", type="circle", x=4, y=4, width=12, height=12, color=(255, 165, 0)),
        S(name="ring", type="circle", x=4, y=22, width=12, height=12, color=(0, 0, 0), bordercolor=(50, 205, 50)),
        S(name="bar", type="bar", x=4, y=48, width=40, height=8, color=(37, 99, 235), bordercolor=(200, 200, 200), text="60"),
        S(name="small", type="text", x=24, y=2, fontsize=13, color=(255, 69, 0), text="TO WIEDIKON"),
        S(name="edge", type="text", x=24, y=18, fontsize=olb.SMALL_TEXT_PX, color=(255, 255, 255), text="1:26"),
        S(name="big", type="text", x=190, y=32, fontsize=olb.SMALL_TEXT_PX + 14, color=(255, 200, 50),
          align="right", valign="middle", text="25"),
    ])


SCREENS = [
    ("00_waiting", None, None),                              # boot idle (no client)
    ("01_scoreboard", "volleyball_matchscore_02", scoreboard()),
    ("02_kscw_idle", "kscw_idle",
        text("team1", "KSC WIEDIKON", "255,200,50") + text("team2", "VBC ZUG", ORANGE)),
    ("03_kscw_crest", "kscw_crest", []),
    ("04_break", "kscw_break", break_screen()),
    ("05_countdown", "volleyball_matchscore_timeout_02", countdown()),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--base-dir", default=HERE, help="firmware dir to render from (default: this dir)")
    ap.add_argument("--out", default=OUT, help="where to write the PNGs (default: samples/)")
    ap.add_argument("--ips", help="comma list for the info screen instead of this host's own "
                                  "addresses, so the render is the same on every machine")
    args = ap.parse_args()
    if args.ips:
        olb._local_ips = lambda: args.ips.split(",")
    if not olb._HAVE_PIL:
        raise SystemExit("Pillow not installed: pip install pillow")
    out = args.out
    os.makedirs(out, exist_ok=True)
    cfg = olb.build_config(args.base_dir)
    renderer = olb.Renderer(cfg["width"], cfg["height"], cfg["buffer_path"], cfg["base_dir"])
    device = olb.Device(cfg, renderer)  # boots showing the idle/waiting screen

    def snapshot(name):
        shutil.copy(cfg["buffer_path"], os.path.join(out, name + ".png"))
        print("  wrote %s" % os.path.join(out, name + ".png"))

    for name, layout, sections in SCREENS:
        if layout:
            reply = device.handle({"cmd": "SetLayout", "value": layout})
            assert reply["status"] == "ok", (name, reply)
        if sections:
            reply = device.handle({"cmd": "SetSections", "value": sections})
            assert reply["status"] == "ok", (name, reply)
        snapshot(name)

    # Shapes and the text ladder, drawn straight through the renderer (no layout file).
    renderer.render(shapes())
    snapshot("06_shapes")

    # The procedural network-info screen (showInfo).
    device.show_info()
    snapshot("07_info")
    print("OK — %d sample screens in %s" % (len(SCREENS) + 2, out))


if __name__ == "__main__":
    main()
