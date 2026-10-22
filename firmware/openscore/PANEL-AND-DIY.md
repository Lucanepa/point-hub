# Panel characteristics + DIY build

Everything below is pulled off the actual C0270 (`setting.ini`, `flushbuffer.cc`, board probing).
It describes the panel openscore and flushBuffer2 drive today.

## Panel & driver characteristics (measured)

| Property | Value | Source |
|---|---|---|
| Resolution | **192 × 64** RGB pixels | `[DISPLAY] width/height`, compiled in |
| Panel type | Outdoor **HUB75** LED matrix | hardware |
| Module layout | **3 × 64×64** panels, single chain, `parallel = 1` | `flushbuffer.cc` `rows=64 cols=64 chain=3` |
| **Scan mode** | **1** (interlaced; the library's default is 0, progressive) — *compiled in, not on the command line* | `flushbuffer.cc:46` |
| Multiplexing | 1 | `setting.ini` |
| GPIO mapping | **`applicon`** = stock `regular` with the **E address line on GPIO26** (not GPIO15) | recovered from the vendor binary |
| PWM | `pwm_bits=7`, `pwm_lsb_nanoseconds=450`, `pwm_dither_bits=2` | `setting.ini [DISPLAY]` |
| GPIO slowdown | 5 | `setting.ini` |
| Hardware pulsing | on (`no_hardware_pulsing=0`) | `setting.ini` |
| Brightness | 40 (%) | `setting.ini` |
| Host | Raspberry Pi (armhf); board HW ver **0.42**; firmware app **0.552** | `config`, `manifest.xml` |
| Refresh | ~62 fps (flushBuffer2 reloads the PNG each frame) | `flushbuffer/README.md` |

**Not readable in software** (read them off the module labels): **pixel pitch** (P-value, e.g. P4/P5/P6),
physical dimensions, and rated power/current. These decide the power supply and the physical case.

The tuning above is Tech4Sport's **outdoor** profile (D in
[`../setting.ini.example`](../setting.ini.example)). It is right for this outdoor panel and wrong
for indoor modules — a DIY build starts from the indoor profile C and measures.

## Building one from open parts

KSC Wiedikon's own design is the **LedBox XL**: the same 192 × 64 at 5 mm pitch from six 64×32
indoor modules, plus a 64×32 bench panel at each end, three HUB75 outputs, powered by USB-C only
(no mains inside), in a plywood box. The full guide — parts, purchase spec, GPIO plan, power path,
safety case, case, build steps and software bring-up — is
[`docs/diy-panel/BUILD.md`](../../docs/diy-panel/BUILD.md).

What carries over from this board unchanged: the bridge and console, openscore, and flushBuffer2
(with the XL's geometry passed as flags and the `regular` mapping instead of `applicon`).
