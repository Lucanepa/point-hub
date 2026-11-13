# Hub board, Level 1 (paper check)

A 90 × 60 mm two-layer board that gathers the small I²C parts behind the Pi: sockets for the
MCP23017 (horn + lights) and DS3231 (clock) modules, the light resistors, the OE pull-up, and
JST-XH sockets for everything that hangs on a cable (INA226 × 2, STUSB4500, SHT40, spare port, the
STATUS and LINK lights, the button, the horn module, the Pi 5 power pads, the lead to the Pi).

`gen.mjs` draws it from the module sizes measured with a ruler (±1 mm) into `hub-level1.html`:
page 1 at 1:1 to lay the real modules on, page 2 with pin names, page 3 the connections and parts.
The paper check was done on 13.11.2026; the KiCad board in `kicad/` is built from these positions
(`kicad/make.sh`, see `kicad/README.md`).

```bash
node docs/diy-panel/hub/gen.mjs
PLAYWRIGHT=/path/to/node_modules/playwright node docs/diy-panel/hub/pdf.cjs   # hub-level1.pdf
```

Print the PDF at 100 % (actual size); the 50 mm bar on page 1 must measure 50 mm.
