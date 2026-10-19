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
# Every mtime becomes that of jpackage's newest file, taken before this script adds any.
epoch=$(find "$work/root/opt" -type f -printf '%T@\n' | sort -n | tail -1)
epoch=${epoch%.*}
if [[ ! -e "$work/root/usr/bin/point-hub" && ! -L "$work/root/usr/bin/point-hub" ]]; then
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
Comment=The console of the LedBox scoreboard
Exec=/opt/point-hub/bin/point-hub
Icon=point-hub
Terminal=false
Categories=Utility;
Keywords=scoreboard;volleyball;ledbox;kscw;
StartupWMClass=ch-kscw-pointhub-desktop-MainKt
DESKTOP
chmod 644 "$work/root/usr/share/applications/point-hub.desktop"
# Depends: the packages of the system libraries the bundle links directly (its ELF files' NEEDED).
# jpackage's own list names the package of every library ldd finds on the build machine, transitive
# ones too, so CI's Ubuntu 22.04 put libpcre3 and libunistring2 in it, which Debian 13 and Ubuntu
# 24.04 no longer have: apt refused to install. The libraries renamed by the 64-bit time_t
# transition are named both ways, the new name first: a bare old name is only a virtual package on
# Debian 13 and Ubuntu 24.04, and Ubuntu satisfied libasound2 with liboss4-salsa-asound2, an OSS
# imitation of ALSA under which Chromium never starts. A library missing from this table fails the
# build: add its package (`dpkg -S <soname>`).
declare -A LIBPKG=(
  [ld-linux-x86-64.so.2]=libc6 [libc.so.6]=libc6 [libdl.so.2]=libc6 [libm.so.6]=libc6
  [libpthread.so.0]=libc6 [librt.so.1]=libc6
  [libgcc_s.so.1]=libgcc-s1 [libstdc++.so.6]=libstdc++6 [libz.so.1]=zlib1g [libexpat.so.1]=libexpat1
  [libasound.so.2]='libasound2t64 | libasound2' [libcups.so.2]='libcups2t64 | libcups2'
  [libatk-1.0.so.0]='libatk1.0-0t64 | libatk1.0-0' [libatk-bridge-2.0.so.0]='libatk-bridge2.0-0t64 | libatk-bridge2.0-0'
  [libatspi.so.0]='libatspi2.0-0t64 | libatspi2.0-0'
  [libglib-2.0.so.0]='libglib2.0-0t64 | libglib2.0-0' [libgio-2.0.so.0]='libglib2.0-0t64 | libglib2.0-0'
  [libgobject-2.0.so.0]='libglib2.0-0t64 | libglib2.0-0'
  [libdbus-1.so.3]=libdbus-1-3 [libudev.so.1]=libudev1
  [libcairo.so.2]=libcairo2 [libpango-1.0.so.0]=libpango-1.0-0
  [libfontconfig.so.1]=libfontconfig1 [libfreetype.so.6]=libfreetype6
  [libnspr4.so]=libnspr4 [libnss3.so]=libnss3 [libnssutil3.so]=libnss3 [libsmime3.so]=libnss3
  [libdrm.so.2]=libdrm2 [libgbm.so.1]=libgbm1 [libGL.so.1]=libgl1
  [libwayland-client.so.0]=libwayland-client0 [libwayland-cursor.so.0]=libwayland-cursor0
  [libxkbcommon.so.0]=libxkbcommon0 [libxcb.so.1]=libxcb1 [libX11.so.6]=libx11-6
  [libXcomposite.so.1]=libxcomposite1 [libXcursor.so.1]=libxcursor1 [libXdamage.so.1]=libxdamage1
  [libXext.so.6]=libxext6 [libXfixes.so.3]=libxfixes3 [libXi.so.6]=libxi6 [libXrandr.so.2]=libxrandr2
  [libXrender.so.1]=libxrender1 [libXtst.so.6]=libxtst6 [libXxf86vm.so.1]=libxxf86vm1
)
mapfile -t elfs < <(find "$work/root/opt" -type f -exec sh -c 'for f; do [ "$(head -c4 "$f" | od -An -c | tr -d " ")" = 177ELF ] && echo "$f"; done' _ {} +)
(( ${#elfs[@]} > 0 )) || { echo "finish-deb: no ELF files under /opt" >&2; exit 1; }
bundled=$(printf '%s\n' "${elfs[@]##*/}" | sort -u)
needed=$(for f in "${elfs[@]}"; do readelf -d "$f" 2>/dev/null; done | sed -n 's/.*(NEEDED).*\[\(.*\)\]$/\1/p' | sort -u)
deps=()
while read -r so; do
  [[ -z "$so" ]] && continue
  grep -qxF "$so" <<<"$bundled" && continue
  [[ -n "${LIBPKG[$so]:-}" ]] || { echo "finish-deb: the bundle links $so, which has no package in LIBPKG" >&2; exit 1; }
  deps+=("${LIBPKG[$so]}")
done <<<"$needed"
depends=$(printf '%s\n' "${deps[@]}" | sort -u | paste -sd, - | sed 's/,/, /g')
grep -q '^Depends: ' "$work/root/DEBIAN/control" || { echo "finish-deb: no Depends in the control file" >&2; exit 1; }
sed -i "s/^Depends: .*/Depends: $depends/" "$work/root/DEBIAN/control"
find "$work/root" -exec touch -h -d "@$epoch" {} +
SOURCE_DATE_EPOCH=$epoch dpkg-deb --root-owner-group -Zxz -z6 -b "$work/root" "$work/out.deb" >/dev/null
mv "$work/out.deb" "$deb"
listing=$(dpkg-deb -c "$deb")
grep -q ' ./usr/bin/point-hub -> /opt/point-hub/bin/point-hub' <<<"$listing" || { echo "finish-deb: symlink missing after rebuild" >&2; exit 1; }
grep -q ' ./usr/share/applications/point-hub.desktop$' <<<"$listing" || { echo "finish-deb: .desktop missing after rebuild" >&2; exit 1; }
! dpkg-deb --ctrl-tarfile "$deb" | tar -xO 2>/dev/null | grep -q xdg-desktop-menu || { echo "finish-deb: xdg-desktop-menu still in the maintainer scripts" >&2; exit 1; }
echo "finished $deb ($(du -h "$deb" | cut -f1))"
