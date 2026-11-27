#!/bin/bash
# Stream Pi on a fresh Raspberry Pi OS Lite (64-bit), set up in Raspberry Pi Imager with a hostname
# (streampi), the Wi-Fi and SSH. Run from the point-hub checkout as the user the service should run
# as (it uses sudo):   bash streampi/setup.sh [--tailscale] [--wifi]
#   --tailscale   also installs Tailscale (log in once with the URL it prints), so the console and
#                 ssh work from anywhere and the LedBox can be reached over the tailnet
#   --wifi        saves the hall networks, best first (NM autoconnect priority):
#                   40 SCHULEN_KTZH      WPA2-Enterprise (LEUnet), first.last.school + password
#                   30 KSCW_eScoresheet  the club router (club vault: "KSCW_eScoresheet WiFi (TP-Link router)")
#                   20 Luca_Hotspot      the owner's phone
#                 Networks joined later on the console page get 15, and the page moves them up or down.
#                 Each password is asked (empty = skip that network) and written straight into a 0600
#                 NetworkManager keyfile, never onto a command line or into the repo.
# SCHULEN_KTZH: wrong credentials or repeated attempts LOCK the account for up to 8 hours (LEUnet
# handbook), so it gets the LedBox's settings: certificate check (SwissSign Gold CA - G2, ktzh.ch),
# one attempt per connect (auth-timeout 12 s, auth-retries 1), and the username shape is checked first.
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

# the console changes the Wi-Fi (nmcli) as the service user: NetworkManager asks polkit, which by
# default only allows the person logged in at the screen
printf '%s\n' 'polkit.addRule(function (action, subject) {' \
  "  if (action.id.indexOf('org.freedesktop.NetworkManager.') === 0 && subject.user === '$USER') return polkit.Result.YES" \
  '})' | sudo tee /etc/polkit-1/rules.d/50-streampi-wifi.rules >/dev/null

sudo install -m 644 streampi.service /etc/systemd/system/streampi.service
sudo sed -i "s#^WorkingDirectory=.*#WorkingDirectory=$PWD#; s#^User=.*#User=$USER#" /etc/systemd/system/streampi.service
sudo systemctl daemon-reload
sudo systemctl enable --now streampi

NM_DIR=/etc/NetworkManager/system-connections
# keyfile values: backslash and leading/trailing spaces escaped (NM keyfile syntax)
kfesc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/^ /\\s/' -e 's/ $/\\s/'; }
# write_profile NAME PRIORITY SSID SECURITY-SECTION  (written 0600 by root, then loaded)
write_profile() {
  local f="$NM_DIR/$1.nmconnection"
  ( umask 077; printf '%s\n' "[connection]" "id=$1" "type=wifi" "autoconnect=true" "autoconnect-priority=$2" "auth-retries=1" "" \
      "[wifi]" "mode=infrastructure" "ssid=$(kfesc "$3")" "" "$4" "" "[ipv4]" "method=auto" "" "[ipv6]" "method=auto" \
    | sudo tee "$f" >/dev/null )
  sudo chmod 600 "$f"; sudo chown root:root "$f"
  sudo nmcli connection load "$f" >/dev/null
  echo "  saved $3 (priority $2)"
}
psk_profile() { # NAME PRIORITY SSID
  local pw; read -rsp "Password for $3 (empty = skip): " pw; echo
  [ -z "$pw" ] && { echo "  skipped $3"; return; }
  write_profile "$1" "$2" "$3" "$(printf '%s\n' "[wifi-security]" "key-mgmt=wpa-psk" "psk=$(kfesc "$pw")")"
}

for arg in "$@"; do
  case "$arg" in
    --wifi)
      echo "SCHULEN_KTZH (WPA2-Enterprise). Wrong details LOCK the account for hours: type carefully."
      read -rp "  username (first.last.school, empty = skip): " KTZH_USER
      if [ -n "$KTZH_USER" ]; then
        if ! [[ "$KTZH_USER" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\.[A-Za-z]+$ ]]; then
          echo "  !! not shaped like first.last.school — SCHULEN_KTZH skipped, nothing was sent"
        else
          read -rsp "  password: " KTZH_PW; echo
          CA=/etc/ssl/certs/streampi-swisssign-gold-g2.pem
          sudo install -m 644 ../provisioning/swisssign-gold-ca-g2.pem "$CA"
          write_profile streampi-schulen 40 SCHULEN_KTZH "$(printf '%s\n' "[wifi-security]" "key-mgmt=wpa-eap" "" \
            "[802-1x]" "eap=ttls;" "phase2-auth=pap" "auth-timeout=12" "identity=$(kfesc "$KTZH_USER")" \
            "password=$(kfesc "$KTZH_PW")" "ca-cert=$CA" "domain-suffix-match=ktzh.ch")"
          unset KTZH_PW
        fi
      fi
      psk_profile streampi-kscw 30 KSCW_eScoresheet
      psk_profile streampi-hotspot 20 Luca_Hotspot
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
