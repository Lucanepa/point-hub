#!/usr/bin/env python3
"""Program the STUSB4500's NVM once, with the settings of docs/diy-panel/BUILD.md section 5.2:

    power_above_5v_only on, PDO2 9 V / 2.0 A, PDO3 20 V / 1.5 A, req_src_current on

    stusb4500_nvm.py           show what the chip holds now and what a write would change
    stusb4500_nvm.py --write   write it, read it back, compare

The NVM has limited write cycles, so a chip that already holds the settings is left alone. The new
values count from the chip's next power-up: unplug it (charger and Qwiic), then plug it in again.
Stop pointhubd first (sudo systemctl stop pointhubd): it polls the same chip.

The sequence and the bit positions are those of SparkFun's STUSB4500 Arduino library
(SparkFun_STUSB4500.cpp), which follows ST's reference code.
"""

import argparse
import subprocess
import sys
import time

import pointhubd as ph

REG_BUFFER, REG_PASSWORD, REG_CTRL_0, REG_CTRL_1 = 0x53, 0x95, 0x96, 0x97
PASSWORD = 0x47
PWR, RST_N, REQ = 0x80, 0x40, 0x10
OP_READ, OP_WRITE_PL, OP_WRITE_SER, OP_ERASE, OP_PROG, OP_SOFT_PROG = 0, 1, 2, 5, 6, 7

def _amps_code(amps):
    """4 bits: 0.25 A steps up to 3 A, 0.5 A steps above."""
    return int(4 * amps) - 1 if amps <= 3 else int(2 * amps) + 5


def _code_amps(code):
    return 0.0 if code == 0 else code * 0.25 + 0.25 if code < 11 else code * 0.5 - 2.5


def patch(sectors):
    """The five sectors with the BUILD.md 5.2 settings in; every other bit is kept."""
    s = [bytearray(x) for x in sectors]
    s[3][2] = (s[3][2] & 0xF9) | (3 << 1)                 # three PDOs in use
    s[3][4] = (s[3][4] & 0xF0) | _amps_code(2.0)          # PDO2 current
    s[3][5] = (s[3][5] & 0x0F) | (_amps_code(1.5) << 4)   # PDO3 current
    v2, v3 = 9 * 20, 20 * 20                              # 50 mV units, 10 bits
    s[4][0] = (s[4][0] & 0x3F) | ((v2 & 0x03) << 6)
    s[4][1] = v2 >> 2
    s[4][2] = v3 & 0xFF
    s[4][3] = (s[4][3] & 0xFC) | (v3 >> 8)
    s[4][6] |= 0x08 | 0x10                                # power_above_5v_only, req_src_current
    return [bytes(x) for x in s]


def describe(sectors):
    s = sectors
    v2 = ((s[4][1] << 2) | (s[4][0] >> 6)) / 20.0
    v3 = (((s[4][3] & 0x03) << 8) | s[4][2]) / 20.0
    return ("PDOs %d | PDO1 5 V / %.2f A | PDO2 %g V / %.2f A | PDO3 %g V / %.2f A | "
            "power_above_5v_only %s | req_src_current %s" % (
                (s[3][2] & 0x06) >> 1, _code_amps(s[3][2] >> 4), v2, _code_amps(s[3][4] & 0x0F),
                v3, _code_amps(s[3][5] >> 4),
                "on" if s[4][6] & 0x08 else "off", "on" if s[4][6] & 0x10 else "off"))


class Nvm:
    def __init__(self, bus, addr=ph.ADDR_STUSB):
        self.bus, self.addr = bus, addr

    def _set(self, reg, *data):
        self.bus.write(self.addr, bytes([reg, *data]))

    def _run(self, opcode, ctrl_0=0):
        """One NVM controller command; the chip clears REQ when it is done."""
        self._set(REG_CTRL_1, opcode)
        self._set(REG_CTRL_0, ctrl_0 | PWR | RST_N | REQ)
        deadline = time.monotonic() + 1.0
        while self.bus.read_reg(self.addr, REG_CTRL_0, 1)[0] & REQ:
            if time.monotonic() > deadline:
                raise TimeoutError("the NVM controller did not finish (opcode %d)" % opcode)
            time.sleep(0.002)

    def _enter(self):
        self._set(REG_PASSWORD, PASSWORD)

    def _power_up(self):
        self._set(REG_CTRL_0, 0)            # reset the NVM controller
        self._set(REG_CTRL_0, PWR | RST_N)

    def _exit(self):
        self._set(REG_CTRL_0, RST_N)
        self._set(REG_PASSWORD, 0)

    def read(self):
        self._enter()
        try:
            self._power_up()
            sectors = []
            for n in range(5):
                self._set(REG_CTRL_0, PWR | RST_N)
                self._run(OP_READ, n)
                sectors.append(self.bus.read_reg(self.addr, REG_BUFFER, 8))
            return sectors
        finally:
            self._exit()

    def write(self, sectors):
        self._enter()
        try:
            self._set(REG_BUFFER, 0)        # must be 0 for the erase
            self._power_up()
            self._run(0x1F << 3 | OP_WRITE_SER)   # all five sectors
            self._run(OP_SOFT_PROG)
            self._run(OP_ERASE)
            for n, data in enumerate(sectors):
                self._set(REG_BUFFER, *data)
                self._set(REG_CTRL_0, PWR | RST_N)
                self._run(OP_WRITE_PL)
                self._run(OP_PROG, n)
        finally:
            self._exit()


def _dump(sectors):
    return "\n".join("  sector %d: %s" % (n, s.hex(" ")) for n, s in enumerate(sectors))


def program(nvm, write, out=print):
    """0 = the chip holds the settings (already, or now); 1 = it does not."""
    now = nvm.read()
    if len(set(now)) == 1:
        # All five sectors alike (all 00 or all ff) is a failed read, not a chip: never write from it.
        out("Read failed: every sector reads %s. Nothing written." % now[0].hex(" "))
        return 1
    want = patch(now)
    out("Now:  %s\n%s" % (describe(now), _dump(now)))
    if now == want:
        out("Already programmed. Nothing to do.")
        return 0
    out("Want: %s\n%s" % (describe(want), _dump(want)))
    if not write:
        out("Nothing written. Run again with --write to program the chip.")
        return 1
    nvm.write(want)
    back = nvm.read()
    if back != want:
        out("WRITE FAILED: the chip reads back\n%s\nRun it again; do not use this chip until it passes." % _dump(back))
        return 1
    out("Written and read back OK. Unplug the chip (charger and Qwiic) and plug it in again.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--write", action="store_true", help="program the chip (default: only show)")
    parser.add_argument("--bus", type=int, help="I2C bus number (default: found like pointhubd does)")
    args = parser.parse_args(argv)
    if subprocess.run(["systemctl", "is-active", "--quiet", "pointhubd"]).returncode == 0:
        sys.exit("pointhubd is running and polls this chip. First: sudo systemctl stop pointhubd")
    number = args.bus if args.bus is not None else ph.find_bus()
    if number is None:
        sys.exit("No I2C bus with a Point Hub part. Check the Qwiic cable, or give --bus N.")
    try:
        bus = ph.I2cBus(number)
        bus.read_reg(ph.ADDR_STUSB, 0x2F, 1)
    except OSError:
        sys.exit("No STUSB4500 at 0x28 on /dev/i2c-%d." % number)
    sys.exit(program(Nvm(bus), args.write))


if __name__ == "__main__":
    main()
