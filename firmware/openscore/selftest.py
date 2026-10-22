#!/usr/bin/env python3
"""
selftest.py — prove openscore over a REAL TCP socket, with no bridge and no panel.

Spins up the server in a thread, connects a raw socket, and speaks the exact gzip/JSON wire
format the bridge uses (verified against src/ledboxProtocol.js): Init(version=2) handshake,
SetLayout, the one-attrib-per-entry SetSections WRITE shape, SetSection, GetLayout, showInfo,
Horn, and the four error paths (bad layout=5, unknown section=6, malformed shape=9, unknown
cmd=1). Asserts every reply and that a 192x64 buffer.png gets rendered. Prints PASS/FAIL.

    python3 selftest.py            # self-hosted server on 127.0.0.1:18889
    python3 selftest.py --port N   # pick the port
"""
import argparse
import os
import socket
import threading
import time

import openscore as olb

HERE = os.path.dirname(os.path.abspath(__file__))


class Client:
    """Minimal request/response client: gzip-frame a {cmd,value}, read one reply frame."""

    def __init__(self, host, port):
        self.sock = socket.create_connection((host, port), timeout=5)
        self.dec = olb.StreamDecoder()

    def call(self, cmd, value=None, **extra):
        frame = {"cmd": cmd, **extra}
        if value is not None:
            frame["value"] = value
        self.sock.sendall(olb.encode(frame))
        # Read until the decoder yields the matching reply.
        while True:
            msgs = self.dec.push(self.sock.recv(65536))
            for m in msgs:
                if m.get("sender") == cmd:
                    return m
            if not msgs:
                time.sleep(0.01)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def attr(name, a, v):
    return {"name": name, "value": {"attrib": a, "value": str(v)}}


def start_server(port):
    cfg = olb.build_config(HERE)
    cfg["port"] = port
    renderer = olb.Renderer(cfg["width"], cfg["height"], cfg["buffer_path"], cfg["base_dir"])
    device = olb.Device(cfg, renderer)
    srv = olb.Server(device, "127.0.0.1", port)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return cfg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18889)
    args = ap.parse_args()

    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    cfg = start_server(args.port)
    time.sleep(0.3)  # let the listener bind

    checks = []

    def check(label, cond, detail=""):
        checks.append((label, bool(cond)))
        print(("  PASS " if cond else "  FAIL ") + label + ("" if cond else "  <- " + str(detail)))

    c = Client("127.0.0.1", args.port)

    # --- handshake ---
    r = c.call("Init", {"version": 2, "typeDevice": "app"}, alias="openvolley", sport="volleyball")
    check("Init handshake -> ok", r.get("status") == "ok", r)
    v = r.get("value", {})
    check("Init returns deviceName+version", v.get("deviceName") and v.get("version"), v)
    check("Init advertises noresend:false", v.get("noresend") is False, v)

    # --- happy path ---
    r = c.call("SetLayout", "volleyball_matchscore_02")
    check("SetLayout match -> ok", r.get("status") == "ok", r)

    r = c.call("SetSections", [
        *[attr("team1", "text", "WIEDIKON")], attr("team1", "color", "37,99,235"),
        attr("score1", "text", "18"), attr("score2", "text", "16"),
        attr("bg_score1", "color", "0,0,0"), attr("bg_score1", "bordercolor", "37,99,235"),
    ])
    check("SetSections WRITE shape -> ok", r.get("status") == "ok", r)

    r = c.call("SetSection", attr("score1", "text", "19"))
    check("SetSection (singular) -> ok", r.get("status") == "ok", r)

    r = c.call("GetLayout")
    check("GetLayout -> volleyball_matchscore_02", r.get("value") == "volleyball_matchscore_02", r)

    r = c.call("GetSections")
    check("GetSections returns a list", isinstance(r.get("value"), list), r)

    r = c.call("showInfo")
    check("showInfo -> ok", r.get("status") == "ok", r)
    c.call("SetLayout", "volleyball_matchscore_02")  # back to the match

    r = c.call("Horn", {"times": 2, "sleep": 0.1})
    check("Horn -> ok", r.get("status") == "ok", r)

    # --- error paths (must mirror the real device's codes) ---
    r = c.call("SetLayout", "does_not_exist")
    check("bad layout -> error 5", r.get("status") == "error" and r.get("error_code") == 5, r)

    c.call("SetLayout", "volleyball_matchscore_02")
    r = c.call("SetSections", [attr("nope", "text", "x")])
    check("unknown section -> error 6", r.get("status") == "error" and r.get("error_code") == 6, r)

    # READ shape sent to a WRITE command: value is an array of attribs -> malformed (9).
    r = c.call("SetSections", [{"name": "team1", "value": [{"attrib": "text", "value": "x"}]}])
    check("READ shape to SetSections -> error 9", r.get("status") == "error" and r.get("error_code") == 9, r)

    r = c.call("Frobnicate", {})
    check("unknown command -> error 1", r.get("status") == "error" and r.get("error_code") == 1, r)

    c.close()

    # --- render proof ---
    buf = cfg["buffer_path"]
    ok_png = os.path.exists(buf)
    dims = ""
    if ok_png and olb._HAVE_PIL:
        from PIL import Image
        with Image.open(buf) as im:
            dims = "%dx%d" % im.size
            ok_png = im.size == (cfg["width"], cfg["height"])
    check("buffer.png rendered at %dx%d" % (cfg["width"], cfg["height"]), ok_png, dims)

    # --- frame writes on the board's filesystem layout ---
    # On the board buffer.png is a tmpfs bind mount, where the atomic rename is EBUSY. Simulate
    # that (no mount needed) and check openscore writes in place instead of dying at startup.
    import errno
    import tempfile
    tmpd = tempfile.mkdtemp(prefix="openscore-selftest-")
    bpath = os.path.join(tmpd, "www", "buffer.png")
    real_replace = olb.os.replace

    def busy_replace(a, b):
        raise OSError(errno.EBUSY, "Device or resource busy", b)

    olb.os.replace = busy_replace
    try:
        r2 = olb.Renderer(cfg["width"], cfg["height"], bpath, HERE)
        try:
            dev2 = olb.Device(dict(cfg, buffer_path=bpath), r2)  # renders idle in __init__
            booted = True
        except OSError as e:
            booted, dev2 = e, None
        check("EBUSY on rename -> Device still boots", booted is True, booted)
        check("EBUSY on rename -> frame written in place", os.path.getsize(bpath) > 0
              and not os.path.exists(bpath + ".tmp"), os.listdir(os.path.dirname(bpath)))
        if dev2 is not None:
            # Heartbeat: an unchanged screen is still re-saved, so the watchdog never sees a stale
            # buffer.png and a splash copied over it (startled) gets painted over.
            with open(bpath, "wb") as f:
                f.write(b"splash")
            dev2.start_heartbeat(every=0.2)
            deadline = time.time() + 3
            while time.time() < deadline and open(bpath, "rb").read(6) == b"splash":
                time.sleep(0.05)
            check("heartbeat repaints an unchanged screen", open(bpath, "rb").read(4) == b"\x89PNG")

        # Any other write failure is logged, not raised into Device/_handle_client.
        def eio_replace(a, b):
            raise OSError(errno.EIO, "I/O error", b)

        olb.os.replace = eio_replace
        r3 = olb.Renderer(cfg["width"], cfg["height"], os.path.join(tmpd, "x", "buffer.png"), HERE)
        try:
            r3.render(olb.Layout(name="__blank__"))
            survived = True
        except OSError as e:
            survived = e
        check("unwritable frame -> render() logs, does not raise", survived is True, survived)
    finally:
        olb.os.replace = real_replace

    # --- text for LEDs: Bold without anti-aliasing at SMALL_TEXT_PX and under ---
    if olb._HAVE_PIL:
        from PIL import Image, ImageDraw
        rt = olb.Renderer(cfg["width"], cfg["height"], os.path.join(tmpd, "t", "buffer.png"), HERE)
        orange = (255, 69, 0)

        def colours(size, text="WIEDIKON 18"):
            lay = olb.Layout(name="t", sections=[olb.Section(name="t", type="text", x=2, y=2, fontsize=size,
                                                             color=orange, text=text)])
            rt.render(lay)
            with Image.open(rt.buffer_path) as im:
                return set(im.convert("RGB").getdata()) - {(0, 0, 0)}

        small = colours(olb.SMALL_TEXT_PX)
        check("text at %d px: every lit pixel is the exact colour (no AA blends)" % olb.SMALL_TEXT_PX,
              small == {orange}, sorted(small)[:6])
        big = colours(olb.SMALL_TEXT_PX + 14, "18")
        check("text at %d px keeps its anti-aliasing" % (olb.SMALL_TEXT_PX + 14), len(big) > 1, len(big))
        face = lambda size: os.path.basename(getattr(rt._font(size), "path", "") or "")  # noqa: E731
        check("small text is Liberation Sans Bold, big text Regular",
              face(olb.SMALL_TEXT_PX) == "LiberationSans-Bold.ttf"
              and face(olb.SMALL_TEXT_PX + 1) == "LiberationSans-Regular.ttf",
              (face(olb.SMALL_TEXT_PX), face(olb.SMALL_TEXT_PX + 1)))
        # Shrink-to-fit measures in the face it draws: a name that fits its box in Regular but not
        # in the wider Bold must still come out inside the box.
        d = ImageDraw.Draw(Image.new("RGB", (192, 64)))
        name = "Volley Zürich"
        reg = olb.ImageFont.truetype(rt._font_path, 20)
        box = int(d.textlength(name, font=reg)) + 1   # exactly what Regular 20 needs
        font, size = rt._fit_font(d, name, 20, box)
        check("shrink-to-fit uses Bold widths (%r fits %d px in Regular 20; Bold comes out at %d, %.0f px)"
              % (name, box, size, d.textlength(name, font=font)),
              size < 20 and d.textlength(name, font=font) <= box < d.textlength(name, font=rt._font(size + 1)),
              size)

    # --- our layouts answer to the names and sections the bridge writes ---
    lays = olb.load_layouts(cfg["layout_dir"])
    want = {
        "volleyball_matchscore_02": ["team1", "team2", "score1", "score2", "bg_score1", "bg_score2", "set1", "set2",
                                     "vs", "timeout1", "timeout2", "sub1", "sub2", "lbl_to", "lbl_sub", "serve1", "serve2"],
        "volleyball_matchscore_timeout_02": ["media", "lbl", "timer", "score1", "score2", "bg_score1", "bg_score2",
                                             "set1", "set2", "sep"],
        "volleyball_matchscore_set_02": ["media"],
    }
    for lname, secs in want.items():
        lay = lays.get(lname)
        missing = [n for n in secs if lay is None or lay.get(n) is None]
        check("layout %s has every section the bridge writes" % lname, not missing, missing)
    vm = lays.get("volleyball_matchscore_02")
    check("its captions are T and S", vm and vm.get("lbl_to").text == "T" and vm.get("lbl_sub").text == "S")
    check("its names and scores carry a width (shrink-to-fit)",
          vm and all(vm.get(n).width > 0 for n in ("team1", "team2", "score1", "score2")))

    passed = sum(1 for _, ok in checks if ok)
    total = len(checks)
    print("\n%d/%d checks passed" % (passed, total))
    raise SystemExit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
