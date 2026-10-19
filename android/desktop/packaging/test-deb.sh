#!/usr/bin/env bash
# Install the finished .deb with apt in clean containers of the distros people have, and start it
# there under Xvfb: apt must take every dependency from Depends alone, and Chromium must paint.
# Needs docker. CI runs it after finish-deb.sh.
#
#   android/desktop/packaging/test-deb.sh build/compose/binaries/main/deb/point-hub_1.1.1_amd64.deb [IMAGE...]
#
# Default images: debian:12-slim debian:13-slim ubuntu:22.04 ubuntu:24.04.
set -euo pipefail
deb=$(realpath "$1"); shift
(( $# )) || set -- debian:12-slim debian:13-slim ubuntu:22.04 ubuntu:24.04
dir=$(dirname "$deb")
name=$(basename "$deb")
fail=0
for img in "$@"; do
  echo "== $img"
  # shellcheck disable=SC2016  # expanded in the container
  out=$(docker run --rm -v "$dir:/w:ro" -e DEB="/w/$name" "$img" sh -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq xvfb xauth >/dev/null 2>&1 || { echo "xvfb: apt failed"; exit 1; }
    apt-get install -y -qq "$DEB" > /tmp/apt.log 2>&1 || { tail -8 /tmp/apt.log; echo "point-hub: apt failed"; exit 1; }
    # What apt chose for the libraries renamed by the time_t transition (an emulation once broke it).
    dpkg-query -W -f "\${Package} \${Version}\n" point-hub "libasound2*" "liboss4-salsa-asound2" 2>/dev/null | grep -v "^\S* $" || true
    POINTHUB_SMOKE=15 timeout 120 xvfb-run -a point-hub 2>&1 | grep "^smoke:" || echo "smoke: no result"
  ' 2>&1) || true
  echo "$out"
  grep -q "^smoke: cef=INITIALIZED painted=true" <<<"$out" || { echo "FAIL $img"; fail=1; }
done
exit $fail
