# Hub board L1 in KiCad

`build_pcb.py` turns `../layout.json` (the paper-checked positions from `../gen.mjs`) into
`hub-l1.kicad_pcb`: standard KiCad 9 footprints, a net on every pad, and a two-layer route from a
small grid router in the same script (0.3 mm tracks, 0.2 mm clearance, 0.6/0.3 mm vias). Nothing
is drawn by hand, so a change to the paper drawing is one `./make.sh` away from new Gerbers.

```bash
./make.sh        # layout.json → board → DRC (must be clean) → img/*.png → hub-l1-jlcpcb.zip
```

The board opens in KiCad as usual (`hub-l1.kicad_pro`). There is no schematic: the connections
are the table on page 3 of `../hub-level1.pdf`, and `build_pcb.py` (`net_for`, `RES_NETS`) is the
netlist.

## Ordering at JLCPCB

Upload `hub-l1-jlcpcb.zip`. Settings: 2 layers, 90 × 60 mm, 1.6 mm, quantity 5, HASL lead-free,
any colour, no assembly. Only PCB, no stencil.

## Parts to solder (all through-hole)

| Ref | Part | Qty |
|---|---|---|
| J1 | JST-XH socket, top entry, 6-pin (B6B-XH-A) | 1 |
| J2–J6, J8–J10 | JST-XH socket, 4-pin (B4B-XH-A) | 8 |
| J7, J11 | JST-XH socket, 2-pin (B2B-XH-A) | 2 |
| U1 | female header 2.54 mm, 1 × 10 and 2 × 10, 8.5 mm tall | 1 + 1 |
| U2 | female header 2.54 mm, 1 × 4, 8.5 mm tall | 1 |
| R1 / R2, R5 / R3, R4, R6, R7 | ¼ W axial: 10k / 150 / 47 | 1 / 2 / 4 |
| H1–H4 | M2.5 standoffs + screws | 4 |

Plus the matching pre-crimped JST-XH pigtails, and 4 straight male pins for the DS3231.

The JST-XH sockets go in with the latch side as printed on the silkscreen outline. The MCP23017
sits label side up (VCC on the square pad of the single row), the DS3231 chip side up on its four
pass-through pins.
