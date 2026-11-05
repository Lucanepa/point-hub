#!/usr/bin/env python3
"""pointhubd against simulated chips: no board, no /dev/i2c. Run: python3 -m unittest (from here)."""

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pointhubd as ph  # noqa: E402


def sht_bytes(temp_c, rh=40.0):
    t = int((temp_c + 45.0) * 65535 / 175.0)
    r = int((rh + 6.0) * 65535 / 125.0)
    tb, rb = bytes([t >> 8, t & 0xFF]), bytes([r >> 8, r & 0xFF])
    return tb + bytes([ph.crc8_sht(tb)]) + rb + bytes([ph.crc8_sht(rb)])


class FakeBus:
    """The board's parts as register maps. `absent` addresses NACK, as a missing part would."""
    number = 7

    def __init__(self):
        self.absent = set()
        self.temp_c = 25.0
        self.rtc_status = 0x00
        self.rail = (5.05, 2.0)     # volts, amps
        self.input = (20.0, 1.0)
        self.rdo = (1 << 28) | (325 << 10) | 325  # object position 1, 3.25 A
        self.mcp = {ph.MCP_IODIRA: 0xFF, ph.MCP_OLATA: 0x00}
        self.writes = []
        self.bad_crc = False

    def _check(self, addr):
        if addr in self.absent:
            raise OSError(121, "Remote I/O error")

    def write(self, addr, payload):
        self._check(addr)
        payload = bytes(payload)
        self.writes.append((addr, payload))
        if addr == ph.ADDR_MCP:
            self.mcp[payload[0]] = payload[1]

    def read(self, addr, length):
        self._check(addr)
        if addr == ph.ADDR_SHT:
            raw = bytearray(sht_bytes(self.temp_c))
            if self.bad_crc:
                raw[2] ^= 0xFF
            return bytes(raw)
        raise OSError(5, "unexpected read")

    def read_reg(self, addr, reg, length):
        self._check(addr)
        if addr == ph.ADDR_MCP:
            return bytes([self.mcp.get(reg, 0)])
        if addr == ph.ADDR_STUSB:
            if reg == 0x2F:
                return b"\x25"
            if reg == 0x91:
                return self.rdo.to_bytes(4, "little")
        if addr == ph.ADDR_RTC and reg == 0x0F:
            return bytes([self.rtc_status])
        if addr in (ph.ADDR_INA_RAIL, ph.ADDR_INA_INPUT):
            volts, amps = self.rail if addr == ph.ADDR_INA_RAIL else self.input
            if reg == 0xFE:
                return b"\x54\x49"
            if reg == 0xFF:
                return b"\x22\x60"
            if reg == 0x01:
                return int(amps / 0.00125).to_bytes(2, "big", signed=True)
            if reg == 0x02:
                return int(volts / 0.00125).to_bytes(2, "big")
        raise OSError(5, "unexpected register 0x%02x at 0x%02x" % (reg, addr))


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def text_of(*path):
    with open(os.path.join(*path)) as f:
        return f.read()


def make(bus=None, **kw):
    clock = Clock()
    tmp = tempfile.mkdtemp(prefix="pointhubd-test-")
    service = ph.Service(bus if bus is not None else FakeBus(), run_dir=tmp, power_file=os.path.join(tmp, "power"),
                         clock=clock, wall=lambda: 1.0, sleep=lambda _s: None, throttled=lambda: None, **kw)
    return service, clock, tmp


class Budget(unittest.TestCase):
    def test_guide_chargers(self):
        # BUILD.md section 5.3: 65 W charger, tablet charging, cool box.
        b = ph.led_budget(65.0, 20.0, temp_c=25.0)
        # (65 * 0.9 - 18) * 0.9 - 8 = 28.45 W at 5 V
        self.assertEqual(b["ma"], 5690)
        self.assertEqual(b["reasons"], [])
        # 18 W on 9 V: no tablet allowance, dimmed but alive.
        b = ph.led_budget(18.0, 9.0, temp_c=25.0)
        self.assertEqual(b["ma"], 1316)

    def test_converter_caps_a_big_charger(self):
        # 240 W cannot get more than the converter's 60 W out of the 5 V side: 52 W for the LEDs.
        self.assertEqual(ph.led_budget(240.0, 48.0, temp_c=25.0)["ma"], 10400)

    def test_temperature_ramp(self):
        self.assertEqual(ph.derate_for_temperature(50.0), 1.0)
        self.assertAlmostEqual(ph.derate_for_temperature(55.0), 0.5)
        self.assertEqual(ph.derate_for_temperature(60.0), 0.0)
        half = ph.led_budget(65.0, 20.0, temp_c=55.0)
        self.assertEqual(half["ma"], 2845)
        self.assertIn("hot", half["reasons"])

    def test_blank_is_never_zero(self):
        # flushBuffer2 reads budget_ma=0 as governor OFF: a hot box must never ask for that.
        hot = ph.led_budget(65.0, 20.0, temp_c=70.0)
        self.assertEqual(hot["ma"], 1)
        self.assertTrue(hot["blanked"])
        starved = ph.led_budget(5.0, 5.0, temp_c=25.0)
        self.assertEqual(starved["ma"], 1)

    def test_no_sensor_or_contract_stays_at_the_weakest(self):
        self.assertEqual(ph.led_budget(None, None, temp_c=25.0)["ma"], 1316)
        self.assertIn("contract unknown", ph.led_budget(None, None, temp_c=25.0)["reasons"])
        # A 100 W charger with no temperature reading must not run at full power unprotected.
        self.assertEqual(ph.led_budget(100.0, 20.0, temp_c=None)["ma"], 1316)

    def test_undervoltage_cuts_a_fifth(self):
        self.assertEqual(ph.led_budget(65.0, 20.0, temp_c=25.0, undervoltage_now=True)["ma"], 4552)

    def test_power_file_format_is_what_flushbuffer_reads(self):
        text = ph.power_file_text(1234)
        self.assertIn("budget_ma=1234\n", text)
        self.assertIn("full_white_ma=19800\n", text)
        self.assertIn("idle_ma=800\n", text)


class Parsers(unittest.TestCase):
    def test_rdo(self):
        r = ph.parse_rdo(((2 << 28) | (150 << 10) | 150).to_bytes(4, "little"))
        self.assertEqual(r, {"position": 2, "amps": 1.5, "contract": True})
        self.assertFalse(ph.parse_rdo(b"\0\0\0\0")["contract"])

    def test_pd_level(self):
        self.assertEqual(ph.nearest_pd_level(19.6), 20.0)
        self.assertEqual(ph.nearest_pd_level(8.9), 9.0)
        self.assertIsNone(ph.nearest_pd_level(0.2))

    def test_sht_crc_known_answer(self):
        # Sensirion's data sheet example: 0xBEEF -> CRC 0x92.
        self.assertEqual(ph.crc8_sht(b"\xBE\xEF"), 0x92)
        r = ph.parse_sht(sht_bytes(25.0, 40.0))
        self.assertAlmostEqual(r["temp_c"], 25.0, delta=0.1)
        self.assertAlmostEqual(r["rh"], 40.0, delta=0.1)
        bad = bytearray(sht_bytes(25.0))
        bad[2] ^= 1
        self.assertIsNone(ph.parse_sht(bytes(bad)))

    def test_light_bytes_match_the_guide(self):
        # BUILD.md section 4.2's example: STATUS green, LINK green, horn off = 0x24.
        self.assertEqual(ph.light_byte("green", "green"), 0x24)
        self.assertEqual(ph.light_byte("yellow", "cyan"), 0x06 | 0x60)
        self.assertEqual(ph.light_byte("off", "off", horn=True), 0x01)
        self.assertEqual(ph.light_byte("red_blink", "off", now=0.1), 0x02)
        self.assertEqual(ph.light_byte("red_blink", "off", now=0.6), 0x00)
        self.assertEqual(ph.light_byte("green_slow", "off", now=0.6), 0x04)
        self.assertEqual(ph.light_byte("green_slow", "off", now=1.1), 0x00)

    def test_throttled(self):
        self.assertTrue(ph.parse_throttled("50001\n")["undervoltage_now"])
        self.assertTrue(ph.parse_throttled("50000\n")["undervoltage_since_boot"])
        self.assertFalse(ph.parse_throttled("0\n")["undervoltage_now"])
        self.assertIsNone(ph.parse_throttled(""))
        # What vcgencmd prints on the bench Pi 5 (Trixie, kernel 6.18).
        self.assertFalse(ph.parse_throttled("throttled=0x0\n")["undervoltage_since_boot"])
        self.assertTrue(ph.parse_throttled("throttled=0x50005\n")["undervoltage_now"])

    def test_read_throttled_survives_no_vcgencmd(self):
        def missing(*_a, **_k):
            raise FileNotFoundError("vcgencmd")
        self.assertIsNone(ph.read_throttled(run=missing))

        class Done:
            returncode = 0
            stdout = "throttled=0x10000\n"
        self.assertTrue(ph.read_throttled(run=lambda *_a, **_k: Done())["undervoltage_since_boot"])


class ServiceBehaviour(unittest.TestCase):
    def test_horn_latch_cleared_before_any_pin_is_an_output(self):
        service, _clock, _ = make()
        service.probe_parts()
        mcp_writes = [w[1] for w in service.bus.writes if w[0] == ph.ADDR_MCP]
        self.assertEqual(mcp_writes[0], bytes([ph.MCP_OLATA, 0x00]))
        self.assertEqual(mcp_writes[1], bytes([ph.MCP_IODIRA, 0x80]))

    def test_full_poll_reports_and_writes_the_budget(self):
        service, _clock, tmp = make()
        service.probe_parts()
        service.poll()
        hw = json.loads(text_of(tmp, "hw.json"))
        self.assertEqual(hw["pd"]["watts"], 65.0)
        self.assertEqual(hw["pd"]["volts"], 20.0)
        self.assertEqual(hw["pd"]["amps"], 3.25)
        self.assertAlmostEqual(hw["rail"]["amps"], 2.0, delta=0.01)
        self.assertAlmostEqual(hw["env"]["temp_c"], 25.0, delta=0.2)
        self.assertTrue(hw["clock_battery_ok"])
        self.assertEqual(hw["budget"]["ma"], 5690)
        self.assertTrue(all(hw["parts"].values()), hw["parts"])
        self.assertIn("budget_ma=5690\n", text_of(tmp, "power"))

    def test_hot_box_blanks_and_goes_red_even_if_the_console_says_ready(self):
        service, _clock, tmp = make()
        service.probe_parts()
        service.command({"cmd": "lights", "status": "green", "link": "off"})
        service.bus.temp_c = 62.0
        service.poll()
        self.assertIn("budget_ma=1\n", text_of(tmp, "power"))
        self.assertEqual(service.effective_status(), "red_blink")

    def test_garbled_temperature_never_blanks(self):
        service, _clock, _ = make()
        service.probe_parts()
        service.bus.bad_crc = True
        service.bus.temp_c = 90.0
        service.poll()
        self.assertFalse(service.hw["budget"]["blanked"])
        self.assertIn("no temperature reading", service.hw["budget"]["reasons"])
        self.assertFalse(service.hw["parts"]["sht40"])

    def test_missing_parts_are_reported_not_fatal(self):
        bus = FakeBus()
        bus.absent = {ph.ADDR_MCP, ph.ADDR_STUSB, ph.ADDR_INA_INPUT, ph.ADDR_RTC}
        service, _clock, _ = make(bus)
        service.probe_parts()
        service.poll()
        self.assertFalse(service.hw["parts"]["mcp23017"])
        self.assertFalse(service.hw["pd"]["contract"])
        self.assertIn("contract unknown", service.hw["budget"]["reasons"])
        self.assertIsNone(service.hw["clock_battery_ok"])
        self.assertEqual(service.command({"cmd": "horn"})["ok"], False)

    def test_a_part_plugged_back_in_is_found(self):
        bus = FakeBus()
        bus.absent = {ph.ADDR_INA_RAIL}
        service, clock, _ = make(bus)
        service.probe_parts()
        service.poll()
        self.assertFalse(service.hw["parts"]["ina_rail"])
        bus.absent = set()
        clock.t += 6.0
        service.poll()
        self.assertTrue(service.hw["parts"]["ina_rail"])
        self.assertIsNotNone(service.hw["rail"])

    def test_no_bus_at_all_still_reports(self):
        clock = Clock()
        tmp = tempfile.mkdtemp(prefix="pointhubd-test-")
        service = ph.Service(None, run_dir=tmp, power_file=os.path.join(tmp, "power"), clock=clock,
                             wall=lambda: 1.0, sleep=lambda _s: None, throttled=lambda: None)
        service.probe_parts()
        service.poll()
        self.assertIsNone(service.hw["bus"])
        self.assertEqual(service.hw["budget"]["ma"], 1316)

    def test_bench_supply_stands_in_for_the_charger(self):
        bus = FakeBus()
        bus.absent = {ph.ADDR_STUSB, ph.ADDR_INA_INPUT}
        service, _clock, _ = make(bus, bench_w=60.0)
        service.probe_parts()
        service.poll()
        self.assertEqual(service.hw["pd"]["source"], "bench")
        self.assertEqual(service.hw["pd"]["watts"], 60.0)

    def test_horn_stops_by_itself_and_is_clamped(self):
        service, clock, _ = make()
        service.probe_parts()
        reply = service.command({"cmd": "horn", "ms": 500})
        self.assertTrue(reply["ok"])
        self.assertEqual(service.bus.mcp[ph.MCP_OLATA] & ph.HORN_BIT, ph.HORN_BIT)
        clock.t += 0.6
        service.tick()
        self.assertEqual(service.bus.mcp[ph.MCP_OLATA] & ph.HORN_BIT, 0)
        self.assertEqual(service.command({"cmd": "horn", "ms": 99999})["ms"], ph.HORN_MAX_MS)
        self.assertEqual(service.bus.mcp[ph.MCP_OLATA] & ph.HORN_BIT, ph.HORN_BIT)
        service.stop()
        self.assertEqual(service.bus.mcp[ph.MCP_OLATA] & ph.HORN_BIT, 0)

    def test_reset_chip_is_set_up_again_with_the_horn_off(self):
        service, _clock, _ = make()
        service.probe_parts()
        service.bus.mcp[ph.MCP_IODIRA] = 0xFF  # power glitch: all inputs again
        service.bus.writes.clear()
        service.poll()
        self.assertEqual(service.mcp_resets, 1)
        self.assertEqual(service.bus.mcp[ph.MCP_IODIRA], 0x80)
        first = [w[1] for w in service.bus.writes if w[0] == ph.ADDR_MCP][0]
        self.assertEqual(first, bytes([ph.MCP_OLATA, 0x00]))

    def test_status_light_rules(self):
        service, clock, _ = make()
        service.probe_parts()
        self.assertEqual(service.effective_status(), "yellow_blink")
        clock.t += ph.BOOT_GRACE_S + 1
        self.assertEqual(service.effective_status(), "red_blink")
        self.assertTrue(service.command({"cmd": "lights", "status": "green", "link": "cyan"})["ok"])
        self.assertEqual(service.effective_status(), "green")
        service.tick()
        self.assertEqual(service.bus.mcp[ph.MCP_OLATA], 0x04 | 0x60)
        clock.t += ph.LIGHTS_STALE_S + 1  # the console died
        self.assertEqual(service.effective_status(), "red_blink")
        service.command({"cmd": "shutdown"})
        self.assertEqual(service.effective_status(), "green_slow")

    def test_bad_requests_are_refused(self):
        service, _clock, _ = make()
        service.probe_parts()
        self.assertFalse(service.command({"cmd": "lights", "status": "pink", "link": "off"})["ok"])
        self.assertFalse(service.command({"cmd": "lights", "status": "green", "link": "green_strobe"})["ok"])
        self.assertFalse(service.command({"cmd": "nope"})["ok"])
        self.assertFalse(service.command({"cmd": "horn", "ms": "loud"})["ok"])

    def test_power_file_error_is_reported_and_retried(self):
        service, _clock, tmp = make()
        service.power_file = os.path.join(tmp, "missing-dir", "power")
        service.probe_parts()
        service.poll()
        self.assertTrue(service.hw["power_file_error"])
        os.makedirs(os.path.join(tmp, "missing-dir"))
        service.poll()
        self.assertIsNone(service.hw["power_file_error"])

    def test_find_bus_prefers_the_one_with_the_parts(self):
        class Empty:
            def __init__(self, n):
                self.number = n

            def read_reg(self, *_a):
                raise OSError(121, "nope")

            def close(self):
                pass

        class Full(FakeBus):
            def __init__(self, n):
                super().__init__()
                self.number = n

            def close(self):
                pass

        opened = {0: Full, 13: Empty}
        got = ph.find_bus(lambda n: opened[n](n), paths=["/dev/i2c-13", "/dev/i2c-0"])
        self.assertEqual(got, 0)
        self.assertIsNone(ph.find_bus(lambda n: Empty(n), paths=["/dev/i2c-13"]))


class SocketRoundTrip(unittest.TestCase):
    def test_serve_answers_on_the_unix_socket(self):
        service, _clock, tmp = make()
        service.clock = time.monotonic
        service.started = time.monotonic()
        service.last_probe = -1e9
        sock = os.path.join(tmp, "ctl.sock")

        # serve() installs signal handlers, which only the main thread may do: run it in a child.
        code = (
            "import sys,os,tempfile;sys.path.insert(0,%r);import pointhubd as ph;"
            "import test_pointhubd as t;"
            "s=ph.Service(t.FakeBus(),run_dir=%r,power_file=%r,throttled=lambda:None);"
            "ph.serve(s,%r)" % (os.path.dirname(os.path.abspath(__file__)), tmp, os.path.join(tmp, "power"), sock)
        )
        child = subprocess.Popen([sys.executable, "-c", code])
        try:
            for _ in range(100):
                if os.path.exists(sock):
                    break
                time.sleep(0.05)
            self.assertEqual(ph.ask(sock, {"cmd": "ping"}), {"ok": True})
            reply = ph.ask(sock, {"cmd": "lights", "status": "green", "link": "blue"})
            self.assertEqual(reply["link"], "blue")
            for _ in range(60):
                if os.path.exists(os.path.join(tmp, "hw.json")):
                    break
                time.sleep(0.05)
            hw = json.loads(text_of(tmp, "hw.json"))
            self.assertEqual(hw["pd"]["watts"], 65.0)
        finally:
            child.terminate()
            child.wait(5)
        self.assertEqual(child.returncode, 0)

    def test_ctl_says_when_the_service_is_not_running(self):
        tmp = tempfile.mkdtemp(prefix="pointhubd-test-")
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pointhubd.py")
        result = subprocess.run([sys.executable, script, "--run-dir", tmp, "ctl", "horn"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("not answering", result.stderr)


if __name__ == "__main__":
    unittest.main()
