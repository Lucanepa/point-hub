#!/usr/bin/env python3
"""pointhubd — the Point Hub board's hardware service.

The one process that talks to the I2C bus on GPIO0/1 (docs/diy-panel/BUILD.md section 4.2):

    0x20 MCP23017   horn (GPA0), STATUS light (GPA1-3), LINK light (GPA4-6)
    0x28 STUSB4500  the USB-PD contract, which decides how much the LEDs may draw
    0x40 INA226     the 5 V rail (2 mOhm shunt)
    0x41 INA226     the charger input (2 mOhm shunt)
    0x44 SHT40      box temperature and humidity
    0x68 DS3231     clock; read only for its "battery died" flag, the kernel owns the time

It lives outside the console on purpose. The thermal cut-off and the power budget are what stop the
box tripping a charger or cooking itself, and neither may depend on a Node process that is restarted
by every deploy. So this writes the budget straight into flushBuffer2's control directory, and the
appliance only reads what this reports (/run/pointhub/hw.json) and asks for lights and the horn over
a unix socket (/run/pointhub/ctl.sock). The C0270 has none of these parts and never runs this.

Standard library only, like everything else on the board's boot path. All bus traffic goes through
I2C_RDWR: a register read is one atomic transaction, so a concurrent reader cannot move the register
pointer between the write and the read, and it works on the DS3231's address while the kernel's RTC
driver holds it (I2C_SLAVE would answer EBUSY).

Usage:
    pointhubd.py                 run the service
    pointhubd.py probe           one look at the bus, for the bench (does not need the service)
    pointhubd.py off             horn off and lights off, straight on the bus (ExecStopPost)
    pointhubd.py ctl horn [ms]   ask the running service to sound the horn (openscore's horn_cmd)
    pointhubd.py ctl lights STATUS LINK
    pointhubd.py ctl shutdown    STATUS goes to the slow green blink (power button pressed)
    pointhubd.py ctl status      what the service sees, as JSON
"""

import argparse
import ctypes
import fcntl
import glob
import json
import os
import re
import selectors
import signal
import socket
import subprocess
import sys
import time

I2C_RDWR = 0x0707
I2C_M_RD = 0x0001

ADDR_MCP = 0x20
ADDR_STUSB = 0x28
ADDR_INA_RAIL = 0x40
ADDR_INA_INPUT = 0x41
ADDR_SHT = 0x44
ADDR_RTC = 0x68

RUN_DIR = "/run/pointhub"
POWER_FILE = "/run/ledbox-panel/power"

# How often the sensors are read. The STUSB4500's ALERT line is not wired (no free GPIO), so the
# contract is polled, and 1 s is what BUILD.md section 5.2 asks for.
POLL_S = 1.0
# The main loop's tick: the upper bound on how late the horn stops and how late a blink flips.
TICK_S = 0.05
# Longest single horn blast this will ever sound, whatever it is asked for. The latch keeps the horn
# on until something writes it off, so a caller's bug must not become a horn that does not stop.
HORN_MAX_MS = 5000
HORN_DEFAULT_MS = 600

# The appliance sends the lights at least this often. Silence past it means the console is dead, and
# a STATUS light still saying "ready" would be lying.
LIGHTS_STALE_S = 30.0
# A board still not ready this long after boot has failed to start, whatever it is doing.
BOOT_GRACE_S = 180.0

STATUS_COLOURS = {"red": 0x02, "green": 0x04, "blue": 0x08, "yellow": 0x06}
LINK_COLOURS = {"red": 0x10, "green": 0x20, "blue": 0x40, "yellow": 0x30, "cyan": 0x60}
HORN_BIT = 0x01
# GPA0 horn, GPA1-3 STATUS, GPA4-6 LINK as outputs; GPA7 stays an input.
MCP_IODIRA = 0x00
MCP_OLATA = 0x14
MCP_DIR = 0x80

# "green", "green_blink" (0.5 s on, 0.5 s off) or "green_slow" (1 s on, 1 s off); "off".
BLINKS = {"": None, "blink": 0.5, "slow": 1.0}

# --------------------------------------------------------------------------------------
# The power budget. Pure, so the arithmetic can be tested without a board.
# --------------------------------------------------------------------------------------

# Conservative defaults, all overridable (PH_*). Calibrate on the finished box (BUILD.md section 5.5).
DEFAULTS = {
    "converter_w": 60.0,    # Mean Well RSD-60G-5, what the 5 V side can deliver at most
    "converter_eff": 0.90,  # its efficiency, near the data sheet's figure at this load
    "margin": 0.10,         # kept back from the contract so a peak does not trip the charger
    "pi_w": 8.0,            # Pi 5 with the fan and the 10-inch screen, on the 5 V side
    "tablet_w": 18.0,       # the tablet charging module, only on a contract of 12 V or more
    "fallback_w": 18.0,     # assumed when the contract cannot be read: the weakest charger we run on
    # Per module at 5 V, measured at first light (BUILD.md section 10.2): 2.3 A at full white and
    # about 0.1 A black. flushBuffer2 averages over the WHOLE 192 x 96 canvas, nine slots of which
    # eight are fitted, so its calibration figure is nine modules' worth: eight lit modules are then
    # 8/9 of the duty, which is eight modules' current.
    "full_white_ma": 9 * 2200,
    "idle_ma": 8 * 100,
    "rise_per_s": 50,
}

TEMP_DERATE_C = 50.0
TEMP_BLANK_C = 60.0


def derate_for_temperature(temp_c):
    """1.0 below 50 C, falling linearly to 0.0 at 60 C (BUILD.md section 5.5)."""
    if temp_c is None:
        return 1.0
    if temp_c <= TEMP_DERATE_C:
        return 1.0
    if temp_c >= TEMP_BLANK_C:
        return 0.0
    return (TEMP_BLANK_C - temp_c) / (TEMP_BLANK_C - TEMP_DERATE_C)


def led_budget(contract_w, volts, *, temp_c=None, undervoltage_now=False, cfg=None):
    """The current the LEDs may draw at 5 V, in mA, and why.

    contract_w None means the contract is unknown. The answer is never 0: flushBuffer2 reads
    budget_ma=0 as "governor off", the very opposite of what a hot or starved box needs, so the
    darkest answer is 1 mA, which its governor turns into brightness 1 (dark at these PWM settings).
    """
    c = dict(DEFAULTS, **(cfg or {}))
    reasons = []
    if contract_w is None:
        contract_w = c["fallback_w"]
        reasons.append("contract unknown")
    tablet = c["tablet_w"] if (volts or 0) >= 12 else 0.0
    input_w = contract_w * (1 - c["margin"]) - tablet
    five_v_w = min(max(input_w, 0.0) * c["converter_eff"], c["converter_w"])
    led_w = max(five_v_w - c["pi_w"], 0.0)
    if temp_c is None:
        # No temperature sensor means no thermal protection: stay at what the weakest charger
        # allows, which is cool enough to be safe whatever the room does.
        weak = max(c["fallback_w"] * (1 - c["margin"]) * c["converter_eff"] - c["pi_w"], 0.0)
        if led_w > weak:
            led_w = weak
        reasons.append("no temperature reading")
    factor = derate_for_temperature(temp_c)
    if factor < 1.0:
        led_w *= factor
        reasons.append("hot")
    if undervoltage_now:
        led_w *= 0.8
        reasons.append("under-voltage")
    ma = max(int(led_w / 5.0 * 1000), 1)
    return {"ma": ma, "led_w": round(led_w, 1), "reasons": reasons, "blanked": factor == 0.0}


def power_file_text(budget_ma, cfg=None):
    """What goes in flushBuffer2's `power` file (flushbuffer.cc: key=value lines)."""
    c = dict(DEFAULTS, **(cfg or {}))
    return ("budget_ma=%d\nfull_white_ma=%d\nidle_ma=%d\nrise_per_s=%d\n"
            % (budget_ma, c["full_white_ma"], c["idle_ma"], c["rise_per_s"]))


# PD levels. The STUSB4500 tells us the current it asked for, not the voltage (the source's list of
# PDOs is only readable at the moment of attach, and its ALERT line is not wired), so the voltage
# comes from what the input INA226 actually measures, snapped to the level it must be.
PD_LEVELS = (5.0, 9.0, 12.0, 15.0, 20.0)


def nearest_pd_level(volts):
    if volts is None or volts < 4.0:
        return None
    return min(PD_LEVELS, key=lambda v: abs(v - volts))


def parse_rdo(raw):
    """RDO_STATUS (0x91, 4 bytes little-endian) as a USB-PD fixed request.

    Object position 0 means no contract. Bits 19:10 are the operating current in 10 mA steps.
    """
    value = int.from_bytes(raw, "little")
    position = (value >> 28) & 0x7
    operating_ma = ((value >> 10) & 0x3FF) * 10
    return {"position": position, "amps": operating_ma / 1000.0, "contract": position != 0}


def crc8_sht(data):
    """The SHT4x's CRC-8: polynomial 0x31, init 0xFF."""
    crc = 0xFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x31) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def parse_sht(raw):
    """Six bytes from the SHT40: T, crc, RH, crc. None when a CRC fails: a wrong temperature could
    blank the panel in a match, so a garbled read counts as no read."""
    if len(raw) != 6 or crc8_sht(raw[0:2]) != raw[2] or crc8_sht(raw[3:5]) != raw[5]:
        return None
    t_raw = (raw[0] << 8) | raw[1]
    rh_raw = (raw[3] << 8) | raw[4]
    return {
        "temp_c": round(-45.0 + 175.0 * t_raw / 65535.0, 1),
        "rh": round(max(0.0, min(100.0, -6.0 + 125.0 * rh_raw / 65535.0)), 1),
    }


def light_byte(status, link, *, horn=False, now=0.0):
    """OLATA for these light states at this moment. Unknown colours are off."""
    def lit(state, colours):
        if not state or state == "off":
            return 0
        colour, _, blink = state.partition("_")
        bits = colours.get(colour, 0)
        period = BLINKS.get(blink)
        if period is None:
            return bits
        return bits if int(now / period) % 2 == 0 else 0
    value = lit(status, STATUS_COLOURS) | lit(link, LINK_COLOURS)
    return value | (HORN_BIT if horn else 0)


def valid_light(state, colours):
    if state == "off":
        return True
    colour, _, blink = str(state).partition("_")
    return colour in colours and blink in BLINKS


def parse_throttled(raw):
    """The firmware's flags, from sysfs ("50000") or vcgencmd ("throttled=0x50000")."""
    if not raw:
        return None
    try:
        value = int(raw.strip().rpartition("=")[2].replace("0x", ""), 16)
    except ValueError:
        return None
    return {"raw": raw.strip(), "undervoltage_now": bool(value & 1), "undervoltage_since_boot": bool(value & (1 << 16))}


# --------------------------------------------------------------------------------------
# The bus and the parts on it.
# --------------------------------------------------------------------------------------

class _I2cMsg(ctypes.Structure):
    _fields_ = [("addr", ctypes.c_uint16), ("flags", ctypes.c_uint16),
                ("len", ctypes.c_uint16), ("buf", ctypes.POINTER(ctypes.c_char))]


class _I2cRdwr(ctypes.Structure):
    _fields_ = [("msgs", ctypes.POINTER(_I2cMsg)), ("nmsgs", ctypes.c_uint32)]


class I2cBus:
    """/dev/i2c-N through I2C_RDWR. Raises OSError when nothing answers."""

    def __init__(self, number):
        self.number = number
        self.fd = os.open("/dev/i2c-%d" % number, os.O_RDWR)

    def close(self):
        os.close(self.fd)

    def _transfer(self, msgs):
        array = (_I2cMsg * len(msgs))(*msgs)
        data = _I2cRdwr(array, len(msgs))
        fcntl.ioctl(self.fd, I2C_RDWR, ctypes.addressof(data))

    def write(self, addr, payload):
        buf = ctypes.create_string_buffer(bytes(payload), len(payload))
        self._transfer([_I2cMsg(addr, 0, len(payload), buf)])

    def read(self, addr, length):
        buf = ctypes.create_string_buffer(length)
        self._transfer([_I2cMsg(addr, I2C_M_RD, length, buf)])
        return bytes(buf.raw[:length])

    def read_reg(self, addr, reg, length):
        out = ctypes.create_string_buffer(bytes([reg]), 1)
        buf = ctypes.create_string_buffer(length)
        self._transfer([_I2cMsg(addr, 0, 1, out), _I2cMsg(addr, I2C_M_RD, length, buf)])
        return bytes(buf.raw[:length])


class Ina226:
    """Current and voltage on a 2 mOhm shunt: 1.25 mA and 1.25 mV per count."""

    # 16 samples averaged, 1.1 ms conversions, continuous: a fresh value every 35 ms, quick enough
    # for the self-test's 0.3 s step and steady enough not to read PWM ripple.
    CONFIG = 0x4527

    def __init__(self, bus, addr):
        self.bus, self.addr = bus, addr

    def init(self):
        maker = self.bus.read_reg(self.addr, 0xFE, 2)
        die = self.bus.read_reg(self.addr, 0xFF, 2)
        if maker != b"\x54\x49" or die != b"\x22\x60":
            raise OSError("not an INA226 at 0x%02x" % self.addr)
        self.bus.write(self.addr, bytes([0x00, self.CONFIG >> 8, self.CONFIG & 0xFF]))

    def read(self):
        shunt = int.from_bytes(self.bus.read_reg(self.addr, 0x01, 2), "big", signed=True)
        vbus = int.from_bytes(self.bus.read_reg(self.addr, 0x02, 2), "big")
        volts = vbus * 0.00125
        amps = shunt * 0.00125
        return {"volts": round(volts, 3), "amps": round(amps, 3), "watts": round(volts * amps, 2)}


class Mcp23017:
    """Horn and lights. Powers up with every pin an input, which keeps the horn silent and the lights
    dark, so the output latch is always cleared BEFORE a pin becomes an output."""

    def __init__(self, bus):
        self.bus = bus
        self.latch = None

    def init(self):
        self.bus.write(ADDR_MCP, bytes([MCP_OLATA, 0x00]))
        self.bus.write(ADDR_MCP, bytes([MCP_IODIRA, MCP_DIR]))
        self.latch = 0

    def healthy(self):
        """False after the chip lost power or was reset: all inputs again, nothing would light up."""
        return self.bus.read_reg(ADDR_MCP, MCP_IODIRA, 1)[0] == MCP_DIR

    def set(self, value):
        if value != self.latch:
            self.bus.write(ADDR_MCP, bytes([MCP_OLATA, value]))
            self.latch = value


def find_bus(open_bus=I2cBus, paths=None):
    """The I2C bus the parts are on: the number differs by Pi and overlay, and BUILD.md section 10.1
    says to find it rather than assume it. PH_I2C_BUS overrides. The bus with the most parts wins,
    so the display's own bus cannot be mistaken for it. Read-only: nothing is written while looking."""
    best, best_score = None, 0
    for path in sorted(paths if paths is not None else glob.glob("/dev/i2c-*")):
        match = re.search(r"(\d+)$", path)
        if not match:
            continue
        try:
            bus = open_bus(int(match.group(1)))
        except OSError:
            continue
        score = 0
        for addr, reg, want in ((ADDR_INA_RAIL, 0xFE, b"\x54\x49"), (ADDR_INA_INPUT, 0xFE, b"\x54\x49"),
                                (ADDR_STUSB, 0x2F, None), (ADDR_MCP, MCP_IODIRA, None)):
            try:
                got = bus.read_reg(addr, reg, 2 if want else 1)
                if want is None or got == want:
                    score += 1
            except OSError:
                pass
        bus.close()
        if score > best_score:
            best, best_score = int(match.group(1)), score
    return best


def read_throttled(run=subprocess.run):
    """The firmware's flags. The kernels this board runs (6.18 on the Pi 5) have no get_throttled in
    sysfs, so vcgencmd: a once-a-second fork is nothing here, unlike in the appliance, because this
    process does not share a core budget with a panel loop that matters on the Pi 5's RP1 PIO."""
    try:
        result = run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_throttled(result.stdout) if result.returncode == 0 else None


# --------------------------------------------------------------------------------------
# The service.
# --------------------------------------------------------------------------------------

def write_atomic(path, text):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


class Service:
    def __init__(self, bus, *, run_dir=RUN_DIR, power_file=POWER_FILE, clock=time.monotonic,
                 wall=time.time, sleep=time.sleep, throttled=read_throttled, cfg=None, bench_w=None):
        self.bus = bus
        self.run_dir = run_dir
        self.power_file = power_file
        self.clock = clock
        self.wall = wall
        self.sleep = sleep
        self.read_throttled = throttled
        self.cfg = dict(DEFAULTS, **(cfg or {}))
        self.bench_w = bench_w  # a bench supply stands in for the charger (PH_BENCH_SUPPLY_W)
        self.started = clock()
        self.parts = {"mcp23017": False, "stusb4500": False, "ina_rail": False, "ina_input": False,
                      "sht40": False, "ds3231": False}
        self.mcp = None
        self.ina_rail = None
        self.ina_input = None
        self.status_light = "yellow_blink"
        self.link_light = "off"
        self.lights_at = None
        self.shutting_down = False
        self.horn_until = None
        self.mcp_resets = 0
        self.last_probe = -1e9
        self.power_text = None
        self.power_error = None
        self.hw = {}
        self.hot = False

    # --- parts ---------------------------------------------------------------------------------
    def probe_parts(self):
        """(Re)find what answers. A part may be loose at boot and pushed back in; nothing here
        assumes a part stays gone or stays there."""
        self.last_probe = self.clock()
        if self.bus is None:
            return
        if not self.parts["mcp23017"]:
            try:
                mcp = Mcp23017(self.bus)
                mcp.init()
                self.mcp, self.parts["mcp23017"] = mcp, True
            except OSError:
                self.mcp = None
        if not self.parts["ina_rail"]:
            self.ina_rail = self._ina(ADDR_INA_RAIL, "ina_rail")
        if not self.parts["ina_input"]:
            self.ina_input = self._ina(ADDR_INA_INPUT, "ina_input")
        if not self.parts["stusb4500"]:
            try:
                self.parts["stusb4500"] = self.bus.read_reg(ADDR_STUSB, 0x2F, 1)[0] in (0x21, 0x25)
            except OSError:
                self.parts["stusb4500"] = False

    def _ina(self, addr, name):
        try:
            ina = Ina226(self.bus, addr)
            ina.init()
            self.parts[name] = True
            return ina
        except OSError:
            self.parts[name] = False
            return None

    def _read_ina(self, ina, name):
        if ina is None:
            return None
        try:
            return ina.read()
        except OSError:
            self.parts[name] = False
            return None

    def _read_contract(self):
        if not self.parts["stusb4500"]:
            return None
        try:
            return parse_rdo(self.bus.read_reg(ADDR_STUSB, 0x91, 4))
        except OSError:
            self.parts["stusb4500"] = False
            return None

    def _read_sht(self):
        if self.bus is None:
            return None
        try:
            self.bus.write(ADDR_SHT, bytes([0xFD]))  # high precision, no heater
            self.sleep(0.01)
            reading = parse_sht(self.bus.read(ADDR_SHT, 6))
            self.parts["sht40"] = reading is not None
            return reading
        except OSError:
            self.parts["sht40"] = False
            return None

    def _read_clock_ok(self):
        """The DS3231's oscillator-stop flag: set means the battery died and the time is fiction."""
        if self.bus is None:
            return None
        try:
            status = self.bus.read_reg(ADDR_RTC, 0x0F, 1)[0]
            self.parts["ds3231"] = True
            return not bool(status & 0x80)
        except OSError:
            self.parts["ds3231"] = False
            return None

    # --- sensors, budget, report ----------------------------------------------------------------
    def poll(self):
        if self.clock() - self.last_probe >= 5.0:
            self.probe_parts()
        rail = self._read_ina(self.ina_rail, "ina_rail")
        supply = self._read_ina(self.ina_input, "ina_input")
        env = self._read_sht()
        clock_ok = self._read_clock_ok()
        throttled = self.read_throttled()
        contract = self._read_contract()

        volts = nearest_pd_level(supply["volts"]) if supply else None
        pd = {"contract": False, "volts": volts, "amps": None, "watts": None, "source": "unknown"}
        if self.bench_w is not None:
            pd.update(contract=True, watts=float(self.bench_w), source="bench")
        elif contract and contract["contract"]:
            pd.update(contract=True, amps=contract["amps"], source="stusb4500")
            if volts:
                pd["watts"] = round(volts * contract["amps"], 1)
            # A contract without a voltage reading is treated as the weakest there is: the box
            # would rather be dim than trip the charger on a number it made up.
        budget = led_budget(pd["watts"], volts, temp_c=env["temp_c"] if env else None,
                            undervoltage_now=bool(throttled and throttled["undervoltage_now"]), cfg=self.cfg)
        self.hot = budget["blanked"]
        self._write_power(budget["ma"])
        if self.mcp is not None:
            try:
                if not self.mcp.healthy():
                    self.mcp_resets += 1
                    self.mcp.init()
            except OSError:
                self.parts["mcp23017"] = False
                self.mcp = None
        self.hw = {
            "ts": self.wall(),
            "uptime_s": round(self.clock() - self.started, 1),
            "bus": getattr(self.bus, "number", None),
            "parts": dict(self.parts),
            "pd": pd,
            "input": supply,
            "rail": rail,
            "env": env,
            "clock_battery_ok": clock_ok,
            "throttled": throttled,
            "budget": budget,
            "lights": {"status": self.effective_status(), "link": self.link_light},
            "horn": self.horn_until is not None,
            "mcp_resets": self.mcp_resets,
            "power_file_error": self.power_error,
        }
        try:
            write_atomic(os.path.join(self.run_dir, "hw.json"), json.dumps(self.hw))
        except OSError as e:
            print("pointhubd: could not write hw.json: %s" % e, file=sys.stderr, flush=True)

    def _write_power(self, budget_ma):
        text = power_file_text(budget_ma, self.cfg)
        if text == self.power_text:
            return
        try:
            write_atomic(self.power_file, text)
            self.power_text, self.power_error = text, None
        except OSError as e:
            # The driver's own --power-budget-ma from setting.ini stays in force. Retried next poll.
            self.power_error = str(e)

    # --- lights and horn ------------------------------------------------------------------------
    def effective_status(self):
        """What STATUS shows now. The appliance decides, but three things it cannot be trusted on
        (because it may be what failed) are decided here."""
        now = self.clock()
        if self.shutting_down:
            return "green_slow"
        if self.hot:
            return "red_blink"
        if self.lights_at is None:
            return "yellow_blink" if now - self.started < BOOT_GRACE_S else "red_blink"
        if now - self.lights_at > LIGHTS_STALE_S:
            return "red_blink"
        return self.status_light

    def tick(self):
        now = self.clock()
        if self.horn_until is not None and now >= self.horn_until:
            self.horn_until = None
        if self.mcp is None:
            return
        value = light_byte(self.effective_status(), self.link_light, horn=self.horn_until is not None, now=now)
        try:
            self.mcp.set(value)
        except OSError:
            self.parts["mcp23017"] = False
            self.mcp = None
            self.horn_until = None

    def horn_off_now(self):
        self.horn_until = None
        if self.mcp is not None:
            try:
                self.mcp.set(self.mcp.latch & ~HORN_BIT if self.mcp.latch else 0)
            except OSError:
                pass

    def command(self, msg):
        cmd = msg.get("cmd")
        if cmd == "ping":
            return {"ok": True}
        if cmd == "status":
            return {"ok": True, "hw": self.hw}
        if cmd == "horn":
            if self.mcp is None:
                return {"ok": False, "error": "the horn switch (MCP23017) does not answer"}
            try:
                ms = int(msg.get("ms", HORN_DEFAULT_MS))
            except (TypeError, ValueError):
                return {"ok": False, "error": "ms must be a number"}
            ms = max(10, min(HORN_MAX_MS, ms))
            self.horn_until = self.clock() + ms / 1000.0
            self.tick()
            return {"ok": True, "ms": ms}
        if cmd == "lights":
            status, link = msg.get("status"), msg.get("link")
            if not valid_light(status, STATUS_COLOURS) or not valid_light(link, LINK_COLOURS):
                return {"ok": False, "error": "unknown light state"}
            self.status_light, self.link_light, self.lights_at = status, link, self.clock()
            self.tick()
            return {"ok": True, "status": self.effective_status(), "link": self.link_light}
        if cmd == "shutdown":
            self.shutting_down = True
            self.tick()
            return {"ok": True}
        if cmd == "measure":
            # A fresh reading for the self-test, not the last poll's.
            return {"ok": True, "rail": self._read_ina(self.ina_rail, "ina_rail"),
                    "input": self._read_ina(self.ina_input, "ina_input")}
        return {"ok": False, "error": "unknown command"}

    def stop(self):
        """Service stopping: the horn must never outlive it (the latch would hold it on)."""
        self.horn_off_now()


def serve(service, sock_path):
    try:
        os.unlink(sock_path)
    except FileNotFoundError:
        pass
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(sock_path)
    os.chmod(sock_path, 0o660)
    listener.listen(8)
    listener.setblocking(False)
    selector = selectors.DefaultSelector()
    selector.register(listener, selectors.EVENT_READ)

    running = {"on": True}
    def stop(_sig, _frame):
        running["on"] = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    service.probe_parts()
    next_poll = 0.0
    try:
        while running["on"]:
            for _key, _events in selector.select(TICK_S):
                _answer_one(service, listener)
            now = service.clock()
            if now >= next_poll:
                next_poll = now + POLL_S
                service.poll()
            service.tick()
    finally:
        service.stop()
        selector.close()
        listener.close()


def _answer_one(service, listener):
    """One short request per connection. A client that dawdles only costs its own 200 ms: the horn
    deadline and the blink are at most that late, which nobody hears or sees."""
    try:
        conn, _ = listener.accept()
    except OSError:
        return
    with conn:
        conn.settimeout(0.2)
        try:
            data = b""
            while b"\n" not in data and len(data) < 4096:
                chunk = conn.recv(1024)
                if not chunk:
                    break
                data += chunk
            reply = service.command(json.loads(data.decode("utf-8") or "{}"))
        except (OSError, ValueError) as e:
            reply = {"ok": False, "error": str(e)}
        try:
            conn.sendall((json.dumps(reply) + "\n").encode("utf-8"))
        except OSError:
            pass


def ask(sock_path, msg, timeout=2.0):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        s.connect(sock_path)
        s.sendall((json.dumps(msg) + "\n").encode("utf-8"))
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
    return json.loads(data.decode("utf-8"))


# --------------------------------------------------------------------------------------
# Command line.
# --------------------------------------------------------------------------------------

def config_from_env(env):
    cfg = {}
    for key, name in (("converter_w", "PH_CONVERTER_W"), ("pi_w", "PH_PI_W"), ("tablet_w", "PH_TABLET_W"),
                      ("margin", "PH_MARGIN"), ("converter_eff", "PH_CONVERTER_EFF"),
                      ("full_white_ma", "PH_FULL_WHITE_MA"), ("idle_ma", "PH_IDLE_MA"),
                      ("rise_per_s", "PH_RISE_PER_S")):
        if env.get(name):
            cfg[key] = float(env[name])
    return cfg


def open_configured_bus(env):
    if env.get("PH_I2C_BUS"):
        return I2cBus(int(env["PH_I2C_BUS"]))
    number = find_bus()
    return I2cBus(number) if number is not None else None


def cmd_probe(env):
    """The bench's first question: is every part there? (BUILD.md section 10.1.)"""
    bus = open_configured_bus(env)
    if bus is None:
        print("No I2C bus with any Point Hub part. Check dtparam=i2c_vc=on, then the wiring to pins 27/28.")
        return 1
    print("bus: /dev/i2c-%d" % bus.number)
    ok = True
    for name, addr, read in (
        ("MCP23017 horn + lights", ADDR_MCP, lambda: "IODIRA=0x%02x" % bus.read_reg(ADDR_MCP, MCP_IODIRA, 1)[0]),
        ("STUSB4500 PD", ADDR_STUSB, lambda: str(parse_rdo(bus.read_reg(ADDR_STUSB, 0x91, 4)))),
        ("INA226 5 V rail", ADDR_INA_RAIL, lambda: str(_ina_once(bus, ADDR_INA_RAIL))),
        ("INA226 input", ADDR_INA_INPUT, lambda: str(_ina_once(bus, ADDR_INA_INPUT))),
        ("SHT40", ADDR_SHT, lambda: str(_sht_once(bus))),
        ("DS3231", ADDR_RTC, lambda: "battery ok" if not (bus.read_reg(ADDR_RTC, 0x0F, 1)[0] & 0x80)
         else "OSCILLATOR STOPPED: battery empty or missing"),
    ):
        try:
            print("  0x%02x %-24s ok  %s" % (addr, name, read()))
        except OSError as e:
            ok = False
            print("  0x%02x %-24s MISSING (%s)" % (addr, name, e.strerror or e))
    return 0 if ok else 1


def _ina_once(bus, addr):
    ina = Ina226(bus, addr)
    ina.init()
    time.sleep(0.05)
    return ina.read()


def _sht_once(bus):
    bus.write(ADDR_SHT, bytes([0xFD]))
    time.sleep(0.01)
    return parse_sht(bus.read(ADDR_SHT, 6))


def cmd_off(env):
    """Horn and lights off without the service (ExecStopPost: it also runs after a crash). Latch only:
    a chip still all-inputs is already silent."""
    bus = open_configured_bus(env)
    if bus is None:
        return 0
    try:
        bus.write(ADDR_MCP, bytes([MCP_OLATA, 0x00]))
    except OSError:
        pass
    return 0


def cmd_ctl(args):
    sock_path = os.path.join(args.run_dir, "ctl.sock")
    what = args.what
    if what == "horn":
        msg = {"cmd": "horn", "ms": int(args.rest[0]) if args.rest else HORN_DEFAULT_MS}
    elif what == "lights":
        msg = {"cmd": "lights", "status": args.rest[0], "link": args.rest[1]}
    elif what in ("shutdown", "status", "ping", "measure"):
        msg = {"cmd": what}
    else:
        print("unknown: %s" % what, file=sys.stderr)
        return 2
    try:
        reply = ask(sock_path, msg)
    except OSError as e:
        print("pointhubd is not answering: %s" % e, file=sys.stderr)
        return 1
    print(json.dumps(reply, indent=2 if what == "status" else None))
    return 0 if reply.get("ok") else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description="Point Hub board hardware service")
    parser.add_argument("--run-dir", default=os.environ.get("PH_RUN_DIR", RUN_DIR))
    parser.add_argument("--power-file", default=os.environ.get("PH_POWER_FILE", POWER_FILE))
    sub = parser.add_subparsers(dest="mode")
    sub.add_parser("probe")
    sub.add_parser("off")
    ctl = sub.add_parser("ctl")
    ctl.add_argument("what")
    ctl.add_argument("rest", nargs="*")
    args = parser.parse_args(argv)

    env = os.environ
    if args.mode == "probe":
        return cmd_probe(env)
    if args.mode == "off":
        return cmd_off(env)
    if args.mode == "ctl":
        return cmd_ctl(args)

    os.makedirs(args.run_dir, exist_ok=True)
    # No bus yet is not fatal: the report then says so, and Diagnostics can name the problem, which
    # a crash-looping unit could not.
    bench = float(env["PH_BENCH_SUPPLY_W"]) if env.get("PH_BENCH_SUPPLY_W") else None
    service = Service(open_configured_bus(env), run_dir=args.run_dir, power_file=args.power_file,
                      cfg=config_from_env(env), bench_w=bench)
    serve(service, os.path.join(args.run_dir, "ctl.sock"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
