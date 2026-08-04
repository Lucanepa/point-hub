#!/bin/bash
# Bring the Netgear A6210 (MT7612U, USB 0846:9053) up as a CLIENT on the LedBox board.
#
# Why: the board has no RTC and today reaches the internet only through the openvolley Pi
# (ledbox-nat.service). If the Pi is off, the board silently loses time and match history gets
# stamped wrong. Its own uplink removes that single point of failure.
#
# The built-in wlan0 keeps serving the ledbox_C0270 AP untouched — separate radio, and NM's
# unmanaged rule is per-interface (wlan0 only), so wlan1 is managed automatically.
#
# The passphrase is staged in /tmp/wl1.txt so it never appears in a command line, in `ps`,
# or in shell history. Written straight into a 0600 NM keyfile, then shredded.
#
# Usage:
#   ./setup-wlan1-client.sh --check          # is the adapter enumerated?
#   ./setup-wlan1-client.sh --scan           # list visible networks on wlan1
#   ./setup-wlan1-client.sh --connect "SSID" # join (reads /tmp/wl1.txt)
#   ./setup-wlan1-client.sh --verify         # prove uplink + NTP work without the Pi
set -uo pipefail

CON=ledbox-uplink
KEYFILE=/etc/NetworkManager/system-connections/${CON}.nmconnection
PASSFILE=/tmp/wl1.txt
# eth0 (via the Pi) sits at metric 100. 50 makes wifi win when present, and leaves the Pi as
# an automatic fallback rather than removing it.
METRIC=50

say() { printf '\n=== %s ===\n' "$*"; }

check() {
  say "USB enumeration"
  if lsusb | grep -qi "0846:9053"; then
    echo "  OK  Netgear A6210 present:"
    lsusb | grep -i "0846:9053" | sed 's/^/      /'
  elif lsusb | grep -qiE "0846:|netgear"; then
    echo "  !!  A Netgear device is present but NOT in wifi mode (0846:9053):"
    lsusb | grep -iE "0846:|netgear" | sed 's/^/      /'
    echo "      -> this is the CD-ROM/storage mode; needs usb-modeswitch."
  else
    echo "  --  no Netgear adapter on the USB bus (not plugged in?)"
  fi

  say "wireless interfaces"
  ls /sys/class/net | tr '\n' ' '; echo
  if [ -d /sys/class/net/wlan1 ]; then
    echo "  OK  wlan1 exists -> $(readlink -f /sys/class/net/wlan1/device/driver | xargs basename 2>/dev/null || echo '?')"
  else
    echo "  --  wlan1 absent"
  fi

  say "driver / firmware"
  lsmod | grep -q mt76x2u && echo "  OK  mt76x2u loaded" || echo "  --  mt76x2u not loaded"
  ls /lib/firmware/mediatek/mt7662u.bin >/dev/null 2>&1 \
    && echo "  OK  mt7662u firmware present" || echo "  !!  mt7662u firmware MISSING"

  say "recent kernel messages"
  sudo dmesg | grep -iE "mt76|usb 1-|wlan1" | tail -12
}

scan() {
  [ -d /sys/class/net/wlan1 ] || { echo "!! wlan1 absent — plug the adapter in first"; exit 1; }
  sudo nmcli device wifi rescan ifname wlan1 2>/dev/null
  sleep 3
  say "visible networks on wlan1"
  nmcli -f SSID,CHAN,FREQ,SIGNAL,SECURITY device wifi list ifname wlan1 | head -25
}

connect() {
  local ssid="${1:-}"
  # key-mgmt: sae = WPA3-Personal, wpa-psk = WPA2. band: a = 5GHz, bg = 2.4GHz, "" = auto.
  local keymgmt="${2:-sae}"
  local band="${3:-a}"
  [ -n "$ssid" ]            || { echo "!! usage: $0 --connect \"SSID\" [sae|wpa-psk] [a|bg|auto]"; exit 1; }
  [ -d /sys/class/net/wlan1 ] || { echo "!! wlan1 absent — plug the adapter in first"; exit 1; }
  [ -s "$PASSFILE" ]        || { echo "!! no passphrase staged at $PASSFILE"; exit 1; }

  local pass; pass=$(cat "$PASSFILE")
  if [ "${#pass}" -lt 8 ] || [ "${#pass}" -gt 63 ]; then
    echo "!! WPA passphrase must be 8-63 chars (got ${#pass})"; exit 1
  fi
  echo "  SSID '$ssid', ${keymgmt}, band='${band:-auto}', passphrase ${#pass} chars (value never printed)"

  local bandline=""
  [ -n "$band" ] && [ "$band" != "auto" ] && bandline="band=$band"

  # Written as a keyfile rather than `nmcli ... wifi-sec.psk`, so the secret never lands in ps.
  sudo tee "$KEYFILE" >/dev/null <<EOF
[connection]
id=$CON
type=wifi
interface-name=wlan1
autoconnect=true
autoconnect-priority=10

[wifi]
mode=infrastructure
ssid=$ssid
$bandline

[wifi-security]
key-mgmt=$keymgmt
psk=$pass

[ipv4]
method=auto
route-metric=$METRIC

[ipv6]
method=auto
addr-gen-mode=default
route-metric=$METRIC
EOF
  sudo chown root:root "$KEYFILE"
  sudo chmod 600 "$KEYFILE"
  shred -u "$PASSFILE" 2>/dev/null || rm -f "$PASSFILE"
  echo "  keyfile written 0600, staging file shredded"

  sudo nmcli connection reload
  say "bringing up $CON"
  sudo nmcli connection up "$CON" ifname wlan1 || { echo "!! failed to come up"; exit 1; }
  sleep 4
  verify
}

verify() {
  say "wlan1 state"
  nmcli -f GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS,IP4.GATEWAY device show wlan1 2>/dev/null \
    | sed 's/^/  /'

  say "AP still up on wlan0? (must be unaffected)"
  printf '  hostapd: %s\n' "$(systemctl is-active hostapd)"
  printf '  wlan0:   %s\n' "$(ip -4 -o addr show wlan0 | awk '{print $4}')"
  # `iw` is not installed on this board — use hostapd's own control interface instead.
  if command -v hostapd_cli >/dev/null 2>&1; then
    printf '  clients: %s associated\n' "$(sudo hostapd_cli -i wlan0 list_sta 2>/dev/null | grep -cE '^([0-9a-f]{2}:){5}')"
  else
    printf '  clients: %s in ARP table\n' "$(ip neigh show dev wlan0 2>/dev/null | grep -c REACHABLE)"
  fi
  printf '  band:    %s\n' "$(nmcli -f ACTIVE,SSID,CHAN,FREQ device wifi list ifname wlan1 2>/dev/null | awk '/^yes/{print $(NF-1), $NF}')"

  say "routing (lower metric wins)"
  ip route | grep -E "^default" | sed 's/^/  /'

  say "internet over wlan1 specifically"
  if ping -c2 -W3 -I wlan1 1.1.1.1 >/dev/null 2>&1; then
    echo "  OK  wlan1 has its own route to the internet — no longer dependent on the Pi"
  else
    echo "  !!  no internet via wlan1"
  fi

  say "clock"
  date
  timedatectl 2>/dev/null | grep -E "synchronized|NTP service" | sed 's/^/  /'
}

case "${1:---check}" in
  --check)   check ;;
  --scan)    scan ;;
  --connect) connect "${2:-}" "${3:-sae}" "${4:-a}" ;;
  --verify)  verify ;;
  *) echo "usage: $0 [--check|--scan|--connect \"SSID\" [sae|wpa-psk] [a|bg|auto]|--verify]"; exit 1 ;;
esac
