#!/usr/bin/env bash
# Builds, checks and exports the hub board. Needs KiCad 9 (kicad-cli + pcbnew for python3) and node.
set -euo pipefail
cd "$(dirname "$0")"
node ../gen.mjs >/dev/null                      # paper drawing + layout.json
python3 build_pcb.py                            # place, route, save hub-l1.kicad_pcb
kicad-cli pcb drc --severity-all --exit-code-violations -o drc.rpt hub-l1.kicad_pcb
mkdir -p img
for side in top bottom; do
  kicad-cli pcb render --side "$side" --width 1800 --height 1200 --quality basic --background opaque -o "img/$side.png" hub-l1.kicad_pcb >/dev/null
done
out=$(mktemp -d)
kicad-cli pcb export gerbers --layers F.Cu,B.Cu,F.Mask,B.Mask,F.Silkscreen,B.Silkscreen,Edge.Cuts \
  --subtract-soldermask --no-protel-ext -o "$out/" hub-l1.kicad_pcb >/dev/null
kicad-cli pcb export drill --format excellon --excellon-units mm --excellon-separate-th -o "$out/" hub-l1.kicad_pcb >/dev/null
python3 -c "import zipfile,os,sys; d=sys.argv[1]; z=zipfile.ZipFile('hub-l1-jlcpcb.zip','w',zipfile.ZIP_DEFLATED); [z.write(os.path.join(d,f),f) for f in sorted(os.listdir(d))]" "$out"
rm -rf "$out" hub-l1.kicad_prl
echo "ok: drc.rpt clean, img/top.png img/bottom.png, hub-l1-jlcpcb.zip"
