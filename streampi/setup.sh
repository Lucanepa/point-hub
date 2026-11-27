#!/bin/bash
# Stream Pi on a fresh Raspberry Pi OS (Lite is enough). Run from the point-hub checkout as the
# user the service should run as (it uses sudo): bash streampi/setup.sh
# shortcut: written 27.11.2026 and checked on x86 Linux only; the first real Pi run may need fixes.
set -euo pipefail
cd "$(dirname "$0")"
sudo apt-get update
sudo apt-get install -y ffmpeg chromium nodejs npm
npm ci --omit=dev --no-audit --no-fund
sudo install -m 644 streampi.service /etc/systemd/system/streampi.service
sudo sed -i "s#^WorkingDirectory=.*#WorkingDirectory=$PWD#; s#^User=.*#User=$USER#" /etc/systemd/system/streampi.service
sudo systemctl daemon-reload
sudo systemctl enable --now streampi
echo
echo "Running. Set the console PIN (4 to 12 digits):"
echo "  sudo -u $USER STATE_DIR=/var/lib/streampi node $PWD/streampi.js set-pin <digits>"
echo "Then open http://$(hostname):8080 on a phone on the same network (or over Tailscale)."
