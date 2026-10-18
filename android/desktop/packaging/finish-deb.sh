#!/usr/bin/env bash
# Finish jpackage's .deb for apt: add the command /usr/bin/point-hub (jpackage only installs
# /opt/point-hub/bin/point-hub and a menu entry). Rebuilt in place, deterministically: every mtime
# set to the newest packaged file's, fixed owner and compressor, so the same input gives the same
# bytes.
#
#   android/desktop/packaging/finish-deb.sh build/compose/binaries/main/deb/point-hub_1.1.0_amd64.deb
set -euo pipefail
deb=$(realpath "$1")
pkg=$(dpkg-deb -f "$deb" Package)
[[ "$pkg" == point-hub ]] || { echo "finish-deb: $deb is package $pkg, not point-hub" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
dpkg-deb -R "$deb" "$work/root"
[[ -x "$work/root/opt/point-hub/bin/point-hub" ]] || { echo "finish-deb: no /opt/point-hub/bin/point-hub" >&2; exit 1; }
if [[ ! -e "$work/root/usr/bin/point-hub" ]]; then
  mkdir -p "$work/root/usr/bin"
  ln -s /opt/point-hub/bin/point-hub "$work/root/usr/bin/point-hub"
fi
epoch=$(find "$work/root" -mindepth 1 ! -path "$work/root/DEBIAN" ! -path "$work/root/DEBIAN/*" -type f -printf '%T@\n' | sort -n | tail -1)
epoch=${epoch%.*}
find "$work/root" -exec touch -h -d "@$epoch" {} +
SOURCE_DATE_EPOCH=$epoch dpkg-deb --root-owner-group --threads-max=1 -Zxz -z6 -b "$work/root" "$work/out.deb" >/dev/null
mv "$work/out.deb" "$deb"
dpkg-deb -c "$deb" | grep -q ' ./usr/bin/point-hub -> /opt/point-hub/bin/point-hub' || { echo "finish-deb: symlink missing after rebuild" >&2; exit 1; }
echo "finished $deb ($(du -h "$deb" | cut -f1))"
