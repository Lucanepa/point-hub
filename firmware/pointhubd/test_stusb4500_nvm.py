#!/usr/bin/env python3
"""stusb4500_nvm against a simulated chip. Run: python3 -m unittest test_stusb4500_nvm (from here)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stusb4500_nvm as nvm  # noqa: E402

# What ST ships (default_sector in SparkFun_STUSB4500.cpp): 5 V/1.5 A, 15 V/1.5 A, 20 V/1 A.
FACTORY = [bytes.fromhex(s) for s in (
    "0000b0aa00450000", "10409c1cff013cdf", "02400f003200fcf1", "001956aff5355f00", "004b9021430040fb")]


class FakeChip:
    """The NVM controller behind registers 0x53 and 0x95-0x97. Programming a sector that was not
    erased first, or anything without the password, does nothing: as on the chip."""

    def __init__(self, sectors=FACTORY):
        self.sectors = [bytes(s) for s in sectors]
        self.reg = {0x95: 0, 0x96: 0, 0x97: 0}
        self.buffer, self.latch, self.erase_mask, self.erased, self.erases = bytes(8), bytes(8), 0, set(), 0

    def write(self, addr, payload):
        reg, data = payload[0], bytes(payload[1:])
        if reg == 0x53:
            self.buffer = (data + self.buffer[len(data):])[:8]
            return
        self.reg[reg] = data[0]
        if reg != 0x96 or not data[0] & nvm.REQ or self.reg[0x95] != nvm.PASSWORD:
            return
        opcode, sector = self.reg[0x97] & 0x07, data[0] & 0x07
        if opcode == nvm.OP_READ:
            self.buffer = self.sectors[sector]
        elif opcode == nvm.OP_WRITE_SER:
            self.erase_mask = self.reg[0x97] >> 3
        elif opcode == nvm.OP_ERASE:
            self.erases += 1
            for n in range(5):
                if self.erase_mask >> n & 1:
                    self.sectors[n] = bytes(8)
                    self.erased.add(n)
        elif opcode == nvm.OP_WRITE_PL:
            self.latch = self.buffer
        elif opcode == nvm.OP_PROG and sector in self.erased:
            self.sectors[sector] = self.latch
            self.erased.discard(sector)
        self.reg[0x96] &= ~nvm.REQ  # done at once

    def read_reg(self, addr, reg, length):
        return self.buffer[:length] if reg == 0x53 else bytes([self.reg[reg]])


class NvmTest(unittest.TestCase):
    def test_patch_from_factory(self):
        got = nvm.patch(FACTORY)
        self.assertEqual(got[:3], FACTORY[:3])
        self.assertEqual(got[3].hex(), "001956aff7555f00")
        self.assertEqual(got[4].hex(), "002d9021430058fb")
        self.assertEqual(nvm.describe(got), "PDOs 3 | PDO1 5 V / 1.50 A | PDO2 9 V / 2.00 A | "
                         "PDO3 20 V / 1.50 A | power_above_5v_only on | req_src_current on")

    def test_show_only_writes_nothing(self):
        chip = FakeChip()
        self.assertEqual(nvm.program(nvm.Nvm(chip), write=False, out=lambda _: None), 1)
        self.assertEqual((chip.sectors, chip.erases), (FACTORY, 0))
        self.assertEqual(chip.reg[0x95], 0)  # test mode left

    def test_write_then_second_run_leaves_the_chip_alone(self):
        chip = FakeChip()
        self.assertEqual(nvm.program(nvm.Nvm(chip), write=True, out=lambda _: None), 0)
        self.assertEqual(chip.sectors, nvm.patch(FACTORY))
        self.assertEqual(nvm.program(nvm.Nvm(chip), write=True, out=lambda _: None), 0)
        self.assertEqual(chip.erases, 1)

    def test_dead_read_never_writes(self):
        chip = FakeChip([bytes(8)] * 5)
        self.assertEqual(nvm.program(nvm.Nvm(chip), write=True, out=lambda _: None), 1)
        self.assertEqual(chip.erases, 0)


if __name__ == "__main__":
    unittest.main()
