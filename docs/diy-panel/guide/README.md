# Point Hub board build manual (generator)

The illustrated, IKEA-style build manual for the Point Hub board: a 3D view of the finished board
(design D: front frame tilting 0–20° on a piano hinge, the scorer's 10.1″ screen in a flap at the back,
recessed handles, pull-out rear foot), the parts and tools, and the build steps. Every drawing is generated to scale from the real
dimensions in millimetres, so a change of size is a change of numbers, not a redraw.

| File | What it is |
|---|---|
| `draw.mjs` | The line drawings: a small projection helper, one function per step, the part and tool icons. The design-D geometry (hinge axis, stay pivot and pin, cap K) lives in `G` at the top; the stay notch positions and the cap-K reach are computed from it. World axes for the standing box: X left→right (0..1020), Y front→back (0..220), Z bottom→top (0..380). |
| `scene.js` | The 3D view (three.js 0.160 from jsDelivr): the box built from its panels, the tilting front with cap, cheeks and ratchet stays, the screen flap, the handles and the pull-out foot (with controls for each), the LED faces drawn dot by dot from real 192×64 / 32×64 screens, the mounts. |
| `gen.mjs` | Builds `build-manual.html` from the two above: cut list, parts, tools, step texts with open points. |
| `build-manual.html` | The generated manual. Open it in a browser. |

Regenerate after a change:

```bash
node docs/diy-panel/guide/gen.mjs
# the same page without the document skeleton, for publishing:
GUIDE_BARE=/path/to/manual.html node docs/diy-panel/guide/gen.mjs
```

The written guide, with the bill of materials, wiring and safety notes, is `docs/diy-panel/BUILD.md`.
