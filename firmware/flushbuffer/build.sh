#!/usr/bin/env bash
# Reproducible build of flushBuffer2 — the open rebuild of the Tech4Sport
# flushBuffer (see README.md). Run on the armhf board, or any armhf Pi with
# g++/make. Needs internet for the two source fetches; if the board has none,
# fetch them on a jump host and drop rgbmatrix-<RGB_SHA>.tar.gz + stb_image-<STB_SHA>.h
# (names below) into $WORK — they are sha256-checked either way.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-/home/pi/flushBuffer-rebuild}"
# Pinned, not `master`: a rebuild must produce the driver we verified, not whatever upstream
# looks like on the day, and a silent upstream change here shows up only as garbage on the glass
# (invisible over the network). The hashes also catch a truncated download or a rate-limit HTML
# page saved under the right name. To move to a newer upstream: change the SHA, run once, check
# the panel with eyes on it (README.md), then record the new sha256 printed by the mismatch error.
# (The binary panel-verified on 2026-08-01 was built from an unrecorded master; these pins are the
# first reproducible baseline, taken 2026-09-23.)
RGB_SHA=51d3231e370593b60952b2c3b18d2e3802329f18
RGB_SUM=cc68787b501298021a715ac0ea0e79ac24f7f6b51b7bdb0dd1f4c928688987a3
STB_SHA=2c980bb59875b0d32144a71867fbdebb2f77cd20
STB_SUM=594c2fe35d49488b4382dbfaec8f98366defca819d916ac95becf3e75f4200b3
RGB_URL="https://codeload.github.com/hzeller/rpi-rgb-led-matrix/tar.gz/$RGB_SHA"
STB_URL="https://raw.githubusercontent.com/nothings/stb/$STB_SHA/stb_image.h"

# Fetch once into the cache, then verify EVERY run — a bad file left by an earlier run must fail
# here, not be skipped because it exists. -f makes an HTTP error fail instead of saving the page.
fetch() {  # url dest sha256
  if [ ! -f "$2" ]; then
    curl -fsSL "$1" -o "$2.part"   # .part so an interrupted fetch never looks cached
    mv "$2.part" "$2"
  fi
  if ! echo "$3  $2" | sha256sum -c --quiet - >/dev/null 2>&1; then
    echo "!! $2: sha256 $(sha256sum "$2" | cut -d' ' -f1), pinned $3" >&2
    echo "!! delete it and re-run; if it still differs, upstream's archive changed — review it" >&2
    exit 1
  fi
}

mkdir -p "$WORK" && cd "$WORK"
fetch "$RGB_URL" "rgbmatrix-$RGB_SHA.tar.gz" "$RGB_SUM"
fetch "$STB_URL" "stb_image-$STB_SHA.h" "$STB_SUM"
SRC="$WORK/rpi-rgb-led-matrix-$RGB_SHA"
[ -d "$SRC" ] || tar xzf "rgbmatrix-$RGB_SHA.tar.gz"
cp "stb_image-$STB_SHA.h" "$SRC/stb_image.h"
cp "$HERE/flushbuffer.cc" "$SRC/flushbuffer.cc"

# Add the custom `applicon` GPIO mapping: stock `regular` with the E-line on
# GPIO26 instead of GPIO15 (recovered from the unstripped vendor binary).
python3 - "$SRC/lib/hardware-mapping.c" <<'PY'
import re, sys
HM = sys.argv[1]; s = open(HM).read()
if '"applicon"' in s:
    print("applicon mapping already present"); raise SystemExit
i = s.index('"regular"'); ob = s.rfind('{', 0, i)
d = 0; j = ob
while j < len(s):
    c = s[j]
    if c == '{': d += 1
    elif c == '}':
        d -= 1
        if d == 0: break
    j += 1
block = s[ob:j+1]
appl, hits = re.subn(r'(\.e\s*=\s*)GPIO_BIT\(15\)', r'\1GPIO_BIT(26)',
                     block.replace('"regular"', '"applicon"'))
# The E-line move IS the applicon mapping. If upstream reformatted that line the substitution
# matches nothing and we would emit a second `regular` under another name — which builds fine
# and drives a 1:32-scan panel as garbage. Refuse instead.
if hits != 1:
    sys.exit("!! expected exactly one `.e = GPIO_BIT(15)` in the regular mapping, found %d" % hits)
k = s.find(',', j)
open(HM, 'w').write(s[:k+1] + "\n\n  " + appl + "," + s[k+1:])
print("added applicon mapping (e=GPIO26)")
PY

make -C "$SRC/lib" -j"$(nproc)"
cd "$SRC"
g++ -I include -I . -O3 -Wall -Wextra -Wno-unused-parameter -std=c++11 \
    -c -o flushbuffer.o flushbuffer.cc
g++ -o flushBuffer2 flushbuffer.o -L lib -lrgbmatrix -lrt -lm -lpthread
echo "built: $SRC/flushBuffer2"
file "$SRC/flushBuffer2"
echo "--- linked libraries (must be stock only) ---"
ldd "$SRC/flushBuffer2"
