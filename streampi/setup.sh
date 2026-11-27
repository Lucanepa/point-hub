#!/bin/bash
# Stream Pi on a fresh Raspberry Pi OS Lite (64-bit), set up in Raspberry Pi Imager with a hostname
# (streampi), the Wi-Fi and SSH. Run from the point-hub checkout as the user the service should run
# as (it uses sudo):   bash streampi/setup.sh [--tailscale] [--kscw-wifi]
#   --tailscale   also installs Tailscale (log in once with the URL it prints), so the console and
#                 ssh work from anywhere and the LedBox can be reached over the tailnet
#   --kscw-wifi   adds the club router KSCW_eScoresheet (the hall Wi-Fi the LedBox and the scoring
#                 tablets use); asks for its password (club vault: "KSCW_eScoresheet WiFi (TP-Link
#                 router)"), never stored in the repo; preferred over other known networks
# shortcut: written 27.11.2026 and checked on x86 Linux only; the first real Pi run may need fixes.
set -euo pipefail
cd "$(dirname "$0")"

sudo apt-get update
sudo apt-get install -y ffmpeg chromium nodejs npm
npm ci --omit=dev --no-audit --no-fund

# Power bank: a USB-C bank gives 5 V / 3 A, so the Pi 5 would limit its USB ports to 0.6 A and the
# camera would not charge. Pi ~1.6 A + camera ≤ 0.9 A + two box fans 0.2 A stay under 3 A.
CONFIG=/boot/firmware/config.txt
if [ -f "$CONFIG" ] && ! grep -q '^usb_max_current_enable=1' "$CONFIG"; then
  echo 'usb_max_current_enable=1' | sudo tee -a "$CONFIG" >/dev/null
  echo "Added usb_max_current_enable=1 to $CONFIG (takes effect after a reboot)."
fi

sudo install -m 644 streampi.service /etc/systemd/system/streampi.service
sudo sed -i "s#^WorkingDirectory=.*#WorkingDirectory=$PWD#; s#^User=.*#User=$USER#" /etc/systemd/system/streampi.service
sudo systemctl daemon-reload
sudo systemctl enable --now streampi

for arg in "$@"; do
  case "$arg" in
    --kscw-wifi)
      read -rsp "KSCW_eScoresheet password: " KSCW_PSK; echo
      sudo nmcli connection delete kscw-router >/dev/null 2>&1 || true
      sudo nmcli connection add type wifi ifname wlan0 con-name kscw-router ssid KSCW_eScoresheet \
        wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$KSCW_PSK" connection.autoconnect yes connection.autoconnect-priority 20 >/dev/null
      unset KSCW_PSK
      echo "Added KSCW_eScoresheet (preferred whenever it is in range)."
      ;;
    --tailscale)
      curl -fsSL https://tailscale.com/install.sh | sh
      sudo tailscale up
      ;;
  esac
done

echo
echo "Running. Set the console PIN (4 to 12 digits):"
echo "  sudo -u $USER STATE_DIR=/var/lib/streampi node $PWD/streampi.js set-pin <digits>"
echo "Then reboot once (for the USB power setting) and open http://$(hostname):8080 on a phone"
echo "on the same network (or over Tailscale)."
