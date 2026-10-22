# LedBox XL build manual (generator)

The illustrated, IKEA-style build manual for the LedBox XL: a 3D view of the finished board,
the parts and tools, and the 17 assembly steps. Every drawing is generated to scale from the real
dimensions in millimetres, so a change of size is a change of numbers, not a redraw.

| File | What it is |
|---|---|
| `draw.mjs` | The line drawings: a small projection helper, one function per step, the part and tool icons. World axes for the standing box: X left→right (0..1020), Y front→back (0..220), Z bottom→top (0..380). |
| `scene.js` | The 3D view (three.js 0.160 from jsDelivr): the box, the LED faces drawn dot by dot from real 192×64 / 32×64 screens, the mounts. |
| `gen.mjs` | Builds `ledbox-xl.html` from the two above: parts list, tools, step texts. |
| `ledbox-xl.html` | The generated manual. Open it in a browser. |

Regenerate after a change:

```bash
node docs/diy-panel/guide/gen.mjs
```

The written guide, with the bill of materials, wiring and safety notes, is `docs/diy-panel/BUILD.md`.
