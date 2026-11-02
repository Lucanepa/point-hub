#!/usr/bin/env bash
# Reproducible build of flushBuffer2 — the open rebuild of the Tech4Sport
# flushBuffer (see README.md). Run on the armhf board, or any armhf Pi with
# g++/make. Needs internet for the two source fetches; if the board has none,
# fetch them on a jump host and drop rgbmatrix-<RGB_SHA>.tar.gz + stb_image-<STB_SHA>.h
# (names below) into $WORK — they are sha256-checked either way.
#
# Two backends (flushbuffer.cc, "TWO BACKENDS"):
#   ./build.sh                     hzeller rpi-rgb-led-matrix: the C0270 and any Pi 1-4. Default,
#                                  and exactly the build it always was.
#   BACKEND=piomatter ./build.sh   Adafruit Piomatter over the RP1 PIO: the Raspberry Pi 5 (Point
#                                  Hub board). Fetches piomatter-<PM_SHA>.tar.gz instead of the
#                                  hzeller tarball; needs g++ with C++20 (Pi OS bookworm's g++ 12
#                                  has it). No cmake, no python, no pip.
# Both also build on an x86 Linux machine as a compile check (WORK=/tmp/fb ./build.sh).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-/home/pi/flushBuffer-rebuild}"
BACKEND="${BACKEND:-hzeller}"
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
# Piomatter, pinned 2026-11-02 (its master that day; NOT yet verified on glass). Its C++ core is
# header-only (src/include/piomatter/) and it carries its own copy of Raspberry Pi's piolib
# (src/piolib/, the /dev/pio0 client), which is what gets compiled here: upstream piolib
# (raspberrypi/utils 3f5fa2965292168b7e428976044f1ac2da50130a) has a header that is not valid C++
# (an implicit void* conversion, include/piolib.h line 967), and the copy is what Piomatter ships
# and is tested with.
PM_SHA=ab6cf42b2bbbf4c9d24baa196a300640011c655f
PM_SUM=6c4fe8a2074c6ab9a458d4183486c1ad7bc0ad753c4d376c71b275217201c8a4
RGB_URL="https://codeload.github.com/hzeller/rpi-rgb-led-matrix/tar.gz/$RGB_SHA"
STB_URL="https://raw.githubusercontent.com/nothings/stb/$STB_SHA/stb_image.h"
PM_URL="https://codeload.github.com/adafruit/Adafruit_Blinka_Raspberry_Pi5_Piomatter/tar.gz/$PM_SHA"

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

case "$BACKEND" in
  hzeller|piomatter) ;;
  *) echo "!! BACKEND=$BACKEND: hzeller (default) or piomatter" >&2; exit 1 ;;
esac

mkdir -p "$WORK" && cd "$WORK"
fetch "$STB_URL" "stb_image-$STB_SHA.h" "$STB_SUM"

if [ "$BACKEND" = piomatter ]; then
  fetch "$PM_URL" "piomatter-$PM_SHA.tar.gz" "$PM_SUM"
  SRC="$WORK/Adafruit_Blinka_Raspberry_Pi5_Piomatter-$PM_SHA"
  [ -d "$SRC" ] || tar xzf "piomatter-$PM_SHA.tar.gz"
  B="$SRC/flushbuffer-build"
  mkdir -p "$B"
  cp "stb_image-$STB_SHA.h" "$B/stb_image.h"
  cp "$HERE/flushbuffer.cc" "$B/flushbuffer.cc"
  INC=(-I "$B" -I "$SRC/src/include" -I "$SRC/src/piolib/include")
  "${CC:-gcc}" -std=gnu11 -O2 -Wall "${INC[@]}" -c -o "$B/piolib.o" "$SRC/src/piolib/piolib.c"
  "${CC:-gcc}" -std=gnu11 -O2 -Wall "${INC[@]}" -c -o "$B/pio_rp1.o" "$SRC/src/piolib/pio_rp1.c"
  # -Wno-missing-field-initializers: Piomatter's own pio_program initialiser (piomatter.h) leaves
  # pio_version at zero, which is what it means.
  "${CXX:-g++}" -std=c++20 -DFLUSHBUFFER_PIOMATTER "${INC[@]}" -O3 -Wall -Wextra -Wno-unused-parameter \
      -Wno-missing-field-initializers -c -o "$B/flushbuffer.o" "$B/flushbuffer.cc"
  "${CXX:-g++}" -o "$SRC/flushBuffer2" "$B/flushbuffer.o" "$B/piolib.o" "$B/pio_rp1.o" -lpthread -lm
  echo "built: $SRC/flushBuffer2 (piomatter backend)"
  file "$SRC/flushBuffer2"
  echo "--- linked libraries (must be stock only) ---"
  ldd "$SRC/flushBuffer2" || true   # fails for a cross build; the binary is still there
  # Notes, not errors: this also runs on a build host. On the Pi 5 itself both must hold.
  [ -e /dev/pio0 ] || echo "note: no /dev/pio0 here. On the Pi 5 that means the rp1-pio driver is missing (kernel too old?)"
  case "$(uname -r)" in
    [0-5].*|6.[0-9].*|6.1[01].*)
      echo "note: kernel $(uname -r): Piomatter's 13.5 MHz pixel clock needs the RP1 DMA speed-up of 6.12+" ;;
  esac
  exit 0
fi

fetch "$RGB_URL" "rgbmatrix-$RGB_SHA.tar.gz" "$RGB_SUM"
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
