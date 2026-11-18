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


class BenchCallout(unittest.TestCase):
    """SATZBALL / MATCHBALL on the bench modules: the bridge writes the hidden `callout` section."""

    def pictures(self, callout=None):
        renderer = os_.Renderer(192, 96, os.path.join(tempfile.mkdtemp(), "b.png"), HERE)
        layout = os_.load_layouts(os.path.join(HERE, "layout"))["volleyball_matchscore_02"]
        values = MATCH + ([("callout", callout[0], callout[1])] if callout else [])
        for name, text, colour in values:
            for s in layout.sections:
                if s.name == name:
                    s.text = text
                    if colour:
                        s.color = colour
        sections = {s.name: s for s in layout.sections}
        return renderer._bench_picture(sections, 1, 2), renderer._bench_picture(sections, 2, 1), layout

    def test_the_section_is_never_drawn_on_the_front(self):
        plain = render("volleyball_matchscore_02", 96, MATCH)
        with_it = render("volleyball_matchscore_02", 96, MATCH + [("callout", "SATZ BALL", (0, 255, 0))])
        self.assertEqual(plain.crop((0, 0, 192, 64)).tobytes(), with_it.crop((0, 0, 192, 64)).tobytes())

    def test_its_two_words_take_the_two_small_rows_and_the_scores_stay(self):
        green = (0, 255, 0)
        plain_l, plain_r, _ = self.pictures()
        left, right, _ = self.pictures(("SATZ BALL", green))
        greens = lambda pic, box: sum(1 for p in pic.crop(box).getdata() if p[1] > 200 and p[0] < 60 and p[2] < 60)
        for pic, before in ((left, plain_l), (right, plain_r)):
            self.assertEqual(pic.crop((0, 0, 32, 44)).tobytes(), before.crop((0, 0, 32, 44)).tobytes())  # both scores as they were
            self.assertGreater(greens(pic, (0, 43, 32, 53)), 10)   # SATZ where the set score was
            self.assertGreater(greens(pic, (0, 53, 32, 64)), 10)   # BALL where T / S was
            self.assertTrue(any(all(pic.getpixel((x, y)) == (0, 0, 0) for x in range(32)) for y in range(50, 56)))
        self.assertNotEqual(left.tobytes(), plain_l.tobytes())

    def test_empty_is_the_normal_bench(self):
        plain_l, _, _ = self.pictures()
        empty_l, _, _ = self.pictures(("", (0, 255, 0)))
        self.assertEqual(plain_l.tobytes(), empty_l.tobytes())


class Glyphs(unittest.TestCase):
    def test_the_exchange_arrow_is_drawn_as_one_the_font_has(self):
        sec = os_.Section(name="msg2", type="text")
        os_.Device._apply_attrib(sec, "text", "12 \u21c4 7")
        self.assertEqual(sec.text, "12 \u2194 7")
        font = os_.Renderer(192, 64, os.path.join(tempfile.mkdtemp(), "b.png"), HERE)._font(20)
        self.assertTrue(font.getmask("\u2194").getbbox())


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
        self.assertEqual(cfg["bench_rotate"], (270, 270))   # both bench modules turned, 16 Nov 2026



class IdleClock(unittest.TestCase):
    """No client yet: the Point Hub board shows its clock, ticking, not the QR screen."""

    def device(self, idle):
        tmp = tempfile.mkdtemp(prefix="point-hub-idle-")
        lay = os.path.join(tmp, "layout")
        os.makedirs(lay)
        clock = os.path.join(HERE, "..", "idle-crest-qr", "33_kscw_clock.xml")
        with open(clock) as src, open(os.path.join(lay, "33_kscw_clock.xml"), "w") as dst:
            dst.write(src.read())
        with open(os.path.join(HERE, "layout", "system", "waiting.xml")) as src, open(os.path.join(lay, "waiting.xml"), "w") as dst:
            dst.write(src.read())
        os.makedirs(os.path.join(tmp, "www"))
        cfg = {"layout_dir": lay, "device_name": "t", "version": "t", "idle_layout": idle}
        return os_.Device(cfg, os_.Renderer(192, 96, os.path.join(tmp, "www", "buffer.png"), HERE))

    def test_point_hub_ini_starts_on_the_clock(self):
        ini = configparser.ConfigParser()
        ini.read(os.path.join(HERE, "setting-point-hub.ini"))
        self.assertEqual(ini.get("DISPLAY", "idle_layout"), "kscw_clock")

    def test_the_idle_clock_runs_by_itself_in_the_hubs_format(self):
        d = self.device("kscw_clock")
        self.assertEqual(d.current.name, "kscw_clock")
        # Mon 16.11.2026 18:30:05 local time
        import time as t
        now = t.mktime((2026, 11, 16, 18, 30, 5, 0, 0, -1))
        self.assertTrue(d._tick_idle_clock(now))
        self.assertEqual(d.current.get("time").text, "18:30:05")
        self.assertEqual(d.current.get("date").text, "Mon 16.11.2026")
        self.assertFalse(d._tick_idle_clock(now))  # same second: no repaint

    def test_a_client_screen_stops_the_idle_clock(self):
        d = self.device("kscw_clock")
        d._set_current("kscw_clock")  # the hub picks the clock itself and writes its own time
        d.current.get("time").text = "T - 05:00"
        self.assertFalse(d._tick_idle_clock())
        self.assertEqual(d.current.get("time").text, "T - 05:00")
        d.show_idle()  # the client left: the clock is back, at once
        self.assertRegex(d.current.get("time").text, r"^\d\d:\d\d:\d\d$")

    def test_the_vendor_default_stays_the_qr_screen(self):
        self.assertEqual(self.device("waiting").current.name, "waiting")
        self.assertEqual(self.device("missing").current.name, "waiting")

if __name__ == "__main__":
    unittest.main()
