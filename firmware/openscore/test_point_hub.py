#!/usr/bin/env python3
"""The Point Hub board's canvas in openscore: no panel, just the picture it would send."""

import configparser
import os
import sys
import tempfile
import unittest

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import openscore as os_  # noqa: E402


def render(layout_name, height=96, values=None, rotate=(90, 270)):
    layouts = os_.load_layouts(os.path.join(HERE, "layout"))
    layout = layouts[layout_name]
    for name, text, colour in values or []:
        for s in layout.sections:
            if s.name == name:
                s.text = text
                if colour:
                    s.color = colour
    tmp = tempfile.mkdtemp(prefix="point-hub-render-")
    path = os.path.join(tmp, "buffer.png")
    os_.Renderer(192, height, path, HERE, bench_rotate=rotate).render(layout)
    with Image.open(path) as img:
        return img.convert("RGB")


MATCH = [("score1", "24", (255, 0, 0)), ("score2", "7", (0, 0, 255)), ("team1", "KSCW", None), ("team2", "VBC", None),
         ("set1", "2", None), ("set2", "1", None), ("timeout1", "1", None), ("timeout2", "2", None),
         ("sub1", "3", None), ("sub2", "6", None)]


def lit(img, box):
    return any(px != (0, 0, 0) for px in img.crop(box).getdata())


class Canvas(unittest.TestCase):
    def test_front_is_unchanged_on_the_taller_canvas(self):
        tall = render("volleyball_matchscore_02", 96, MATCH)
        short = render("volleyball_matchscore_02", 64, MATCH)
        self.assertEqual(tall.size, (192, 96))
        self.assertEqual(tall.crop((0, 0, 192, 64)).tobytes(), short.tobytes())

    def test_each_bench_shows_its_own_team_on_top(self):
        img = render("volleyball_matchscore_02", 96, MATCH, rotate=(0, 0))
        # rotate 0 cannot fit a slot, so read the pictures through the renderer's own helper instead.
        self.assertEqual(img.size, (192, 96))
        renderer = os_.Renderer(192, 96, os.path.join(tempfile.mkdtemp(), "b.png"), HERE)
        layout = os_.load_layouts(os.path.join(HERE, "layout"))["volleyball_matchscore_02"]
        for name, text, colour in MATCH:
            for s in layout.sections:
                if s.name == name:
                    s.text = text
                    if colour:
                        s.color = colour
        sections = {s.name: s for s in layout.sections}
        left = renderer._bench_picture(sections, 1, 2)
        right = renderer._bench_picture(sections, 2, 1)
        self.assertEqual(left.size, (32, 64))
        reds = lambda pic, box: sum(1 for p in pic.crop(box).getdata() if p[0] > 200 and p[2] < 60)
        blues = lambda pic, box: sum(1 for p in pic.crop(box).getdata() if p[2] > 200 and p[0] < 60)
        # The two small rows at the bottom must not run into each other: a dark line between them.
        self.assertTrue(any(all(left.getpixel((x, y)) == (0, 0, 0) for x in range(32)) for y in range(50, 56)))
        self.assertGreater(reds(left, (0, 0, 32, 24)), 20)    # left bench: red team on top
        self.assertGreater(blues(left, (0, 24, 32, 48)), 5)
        self.assertGreater(blues(right, (0, 0, 32, 24)), 5)   # right bench: blue team on top
        self.assertGreater(reds(right, (0, 24, 32, 48)), 20)

    def test_benches_land_on_the_two_fitted_modules_and_the_first_slot_stays_dark(self):
        # The slot nearest the Pi is the LAST one of the row: x = 0-63 falls off the end of the chain.
        img = render("volleyball_matchscore_02", 96, MATCH)
        self.assertTrue(lit(img, (128, 64, 192, 96)))
        self.assertTrue(lit(img, (64, 64, 128, 96)))
        self.assertFalse(lit(img, (0, 64, 64, 96)))

    def test_benches_stay_dark_without_a_score(self):
        img = render("kscw_idle", 96, [])
        self.assertFalse(lit(img, (0, 64, 192, 96)))

    def test_a_front_layout_never_reaches_the_bench_row(self):
        # On the screens without a score the whole third row must stay dark, edge cases included.
        for name in ("kscw_idle", "kscw_crest", "kscw_break"):
            self.assertFalse(lit(render(name, 96, []), (0, 64, 192, 65)), name)

    def test_a_c0270_canvas_draws_no_bench(self):
        self.assertEqual(render("volleyball_matchscore_02", 64, MATCH).size, (192, 64))

    def test_timeout_clock_reaches_the_benches(self):
        layouts = os_.load_layouts(os.path.join(HERE, "layout"))
        self.assertIn("timer", {s.name for s in layouts["volleyball_matchscore_timeout_02"].sections})
        img = render("volleyball_matchscore_timeout_02", 96, [("timer", "0:30", (255, 255, 255)), ("score1", "12", None), ("score2", "9", None)])
        self.assertTrue(lit(img, (128, 64, 192, 96)))


class TestScreen(unittest.TestCase):
    def test_every_fitted_module_is_framed_and_the_empty_slot_is_dark(self):
        img = render("kscw_test", 96)
        slots = [(0, 0), (64, 0), (128, 0), (0, 32), (64, 32), (128, 32), (128, 64), (64, 64)]
        for x, y in slots:
            self.assertEqual(img.getpixel((x, y)), (255, 255, 255), (x, y))
            self.assertEqual(img.getpixel((x + 63, y + 31)), (255, 255, 255), (x, y))
        self.assertFalse(lit(img, (0, 64, 64, 96)))


class Config(unittest.TestCase):
    def test_point_hub_settings(self):
        ini = configparser.ConfigParser()
        ini.read(os.path.join(HERE, "setting-point-hub.ini"))
        self.assertEqual(ini.getint("DISPLAY", "height"), 96)
        self.assertEqual(ini.get("DISPLAY", "hardware_mapping"), "regular")
        self.assertEqual(ini.get("DISPLAY", "rgb_sequence"), "RGB")
        tmp = tempfile.mkdtemp()
        with open(os.path.join(HERE, "setting-point-hub.ini")) as f, open(os.path.join(tmp, "setting.ini"), "w") as g:
            g.write(f.read())
        cfg = os_.build_config(tmp)
        self.assertEqual(cfg["height"], 96)
        self.assertIn("pointhubd.py ctl horn", cfg["horn_cmd"])
        self.assertEqual(cfg["bench_rotate"], (90, 270))


if __name__ == "__main__":
    unittest.main()
