#!/usr/bin/env bash
# Rasterise the adaptive-icon layers (foreground + monochrome) with headless Chrome into
# app/src/main/res/mipmap-*dpi/. Re-runnable; the PNGs are committed so builds need no Chrome.
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME=${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser)}
RES=app/src/main/res
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
declare -A SIZES=([mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432)
for layer in foreground monochrome; do
  for d in "${!SIZES[@]}"; do
    n=${SIZES[$d]}
    mkdir -p "$RES/mipmap-$d"
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
      --user-data-dir="$TMP/profile" --default-background-color=00000000 \
      --window-size="$n,$n" --screenshot="$RES/mipmap-$d/ic_launcher_$layer.png" \
      "file://$PWD/tools/icon-$layer.html" >/dev/null 2>&1
  done
done
command -v optipng >/dev/null && optipng -quiet -o5 "$RES"/mipmap-*/ic_launcher_*.png || true
ls -l "$RES"/mipmap-*/ic_launcher_*.png
