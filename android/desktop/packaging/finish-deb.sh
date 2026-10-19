#!/usr/bin/env bash
# Finish jpackage's .deb for apt, rebuilt in place, deterministically (every mtime set to the newest
# packaged file's, fixed owner and compressor, so the same input gives the same bytes):
#   - the command /usr/bin/point-hub (jpackage only installs /opt/point-hub/bin/point-hub);
#   - the menu entry as plain files, /usr/share/applications/point-hub.desktop ("Point Hub") and its
#     icon in hicolor, instead of jpackage's postinst/prerm calling xdg-desktop-menu: that exits 3
#     on a minimal system without /usr/share/desktop-directories, and apt then fails to configure.
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
# The menu entry: no xdg-desktop-menu in the maintainer scripts, a .desktop file and an icon instead
# (dpkg's triggers refresh the menu caches on systems that have them).
for s in postinst prerm; do
  [[ -f "$work/root/DEBIAN/$s" ]] && sed -i '/xdg-desktop-menu/d' "$work/root/DEBIAN/$s"
done
rm -f "$work/root/opt/point-hub/lib/point-hub-point-hub.desktop"
install -D -m 644 "$work/root/opt/point-hub/lib/point-hub.png" "$work/root/usr/share/icons/hicolor/512x512/apps/point-hub.png"
mkdir -p "$work/root/usr/share/applications"
cat > "$work/root/usr/share/applications/point-hub.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Point Hub
GenericName=Scoreboard console
Comment=The console of the KSCW LedBox scoreboard
Exec=/opt/point-hub/bin/point-hub
Icon=point-hub
Terminal=false
Categories=Utility;
Keywords=scoreboard;volleyball;ledbox;kscw;
StartupWMClass=ch-kscw-pointhub-desktop-MainKt
DESKTOP
chmod 644 "$work/root/usr/share/applications/point-hub.desktop"
epoch=$(find "$work/root" -mindepth 1 ! -path "$work/root/DEBIAN" ! -path "$work/root/DEBIAN/*" -type f -printf '%T@\n' | sort -n | tail -1)
epoch=${epoch%.*}
find "$work/root" -exec touch -h -d "@$epoch" {} +
SOURCE_DATE_EPOCH=$epoch dpkg-deb --root-owner-group -Zxz -z6 -b "$work/root" "$work/out.deb" >/dev/null
mv "$work/out.deb" "$deb"
listing=$(dpkg-deb -c "$deb")
grep -q ' ./usr/bin/point-hub -> /opt/point-hub/bin/point-hub' <<<"$listing" || { echo "finish-deb: symlink missing after rebuild" >&2; exit 1; }
grep -q ' ./usr/share/applications/point-hub.desktop$' <<<"$listing" || { echo "finish-deb: .desktop missing after rebuild" >&2; exit 1; }
! dpkg-deb --ctrl-tarfile "$deb" | tar -xO 2>/dev/null | grep -q xdg-desktop-menu || { echo "finish-deb: xdg-desktop-menu still in the maintainer scripts" >&2; exit 1; }
echo "finished $deb ($(du -h "$deb" | cut -f1))"
