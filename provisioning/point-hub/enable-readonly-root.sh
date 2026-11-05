#!/bin/bash
# Read-only root (BUILD.md section 10.7): unplugging is the board's off switch, and a pulled plug
# must not corrupt the card. Run on the Pi, as root, once everything else works. Changes made after
# this vanish at the next reboot, except on /data. To update the board later: sudo raspi-config
# nonint do_overlayfs 1, reboot, change, this script again.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
mountpoint -q /data || { echo "/data is not mounted: settings and match history would be lost. See README.md, step 1."; exit 1; }
[ -d /data/pointhub ] || { echo "/data/pointhub is missing: run setup-board.sh first."; exit 1; }
grep -q '/data' /etc/fstab || { echo "/data is not in /etc/fstab: it would not come back after a reboot."; exit 1; }
# Tailscale and the wlan1 hall login keep state that must survive too.
for d in /var/lib/tailscale; do
  [ -L "$d" ] || { [ -e "$d" ] && mkdir -p "/data$d" && cp -a "$d/." "/data$d/" && rm -rf "$d" && ln -s "/data$d" "$d"; } || true
done
raspi-config nonint do_overlayfs 0
echo "Read-only root enabled at the next reboot. Check afterwards: touch /x fails to survive a reboot, /data keeps its files."
