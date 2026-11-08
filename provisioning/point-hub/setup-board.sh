#!/bin/bash
# One-time setup of a Point Hub board (Pi 5, Raspberry Pi OS Lite 64-bit). Run ON the Pi, as root,
# from a checkout of this repo. Safe to run again. See README.md in this folder for the order.
#
# NOT YET RUN ON THE REAL BOARD. Everything it installs was written before the parts arrived; go
# through README.md's bench list and expect to fix the odd line.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Run as root: sudo $0"; exit 1; }
REPO=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$REPO/provisioning/point-hub"
OWNER=pi
LED=/home/$OWNER/ledbox
BRIDGE=/home/$OWNER/ledbox-bridge
STATE=/data/pointhub
NODE_VERSION=${NODE_VERSION:-22.23.4}

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3-pil i2c-tools build-essential curl rsync dnsmasq iptables \
  labwc squeekboard wlr-randr chromium libglib2.0-bin dbus
# The eScoresheet runs natively on the screen. The arm64 .deb is a workflow artifact, not on APT: put
# it in the repo folder before this script, or install it later.
for deb in "$REPO"/openvolley-escoresheet_*_arm64.deb; do
  [ -e "$deb" ] && apt-get install -y "$deb"
done

echo "== boot config (managed block, replaced on every run)"
CFG=/boot/firmware/config.txt
sed -i '/^# >>> point-hub/,/^# <<< point-hub/d' "$CFG"
cat >> "$CFG" <<'CONF'
# >>> point-hub (provisioning/point-hub/setup-board.sh)
enable_uart=0
dtparam=i2c_vc=on
dtoverlay=i2c-rtc,ds3231,i2c0
gpio=18=op,dh
# <<< point-hub
CONF
sed -i 's/ *console=serial0,[0-9]*//' /boot/firmware/cmdline.txt

echo "== Node $NODE_VERSION (arm64)"
if ! /opt/nodejs/bin/node -v 2>/dev/null | grep -qx "v$NODE_VERSION"; then
  T=$(mktemp -d)
  curl -fsSL -o "$T/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz"
  curl -fsSL -o "$T/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  want=$(grep " node-v$NODE_VERSION-linux-arm64.tar.xz\$" "$T/SHASUMS256.txt" | cut -d' ' -f1)
  [ "$(sha256sum "$T/node.tar.xz" | cut -d' ' -f1)" = "$want" ] || { echo "Node checksum mismatch"; exit 1; }
  mkdir -p "/opt/nodejs-$NODE_VERSION"
  tar -xJf "$T/node.tar.xz" --strip-components=1 -C "/opt/nodejs-$NODE_VERSION"
  ln -sfn "/opt/nodejs-$NODE_VERSION" /opt/nodejs
  ln -sf /opt/nodejs/bin/node /usr/local/bin/node
  rm -rf "$T"
fi

echo "== hardware service"
mkdir -p /opt/pointhub
install -m 0755 "$REPO/firmware/pointhubd/pointhubd.py" /opt/pointhub/pointhubd.py
install -m 0755 "$HERE/pointhub-screen" /opt/pointhub/pointhub-screen
rsync -a --delete "$HERE/squeekboard/" /opt/pointhub/squeekboard/
install -m 0755 "$HERE/pointhub-backup-stick" /opt/pointhub/pointhub-backup-stick
install -m 0644 "$HERE/99-pointhub-backup-stick.rules" /etc/udev/rules.d/99-pointhub-backup-stick.rules
[ -e /etc/default/pointhubd ] || cat > /etc/default/pointhubd <<'CONF'
# PH_I2C_BUS=0            found by itself; set it only if the probe picks the wrong bus
# PH_BENCH_SUPPLY_W=60    a bench supply instead of a USB-PD charger
# PH_FULL_WHITE_MA=19800  calibration (BUILD.md section 5.5); PH_IDLE_MA, PH_PI_W, PH_TABLET_W
CONF

echo "== renderer and LED driver"
install -d -o "$OWNER" -g "$OWNER" "$LED" "$LED/bin" "$LED/www" "$LED/media"
rsync -a --delete --exclude='__pycache__' "$REPO/firmware/openscore/layout/" "$LED/layout/"
# The C0270's authored screens too, without its three-module test screen: the eight-module one above.
for f in "$REPO"/layouts/*_kscw_*.xml "$REPO"/layouts/*_beach_matchscore.xml "$REPO"/layouts/*_basketball_matchscore.xml "$REPO"/layouts/20_openvolley_timeout.xml; do
  case "$f" in *36_kscw_test.xml) continue ;; esac
  install -m 0644 "$f" "$LED/layout/"
done
install -m 0644 "$REPO/firmware/openscore/openscore.py" "$LED/openscore.py"
rsync -a "$REPO/firmware/openscore/fonts/" "$LED/fonts/"
rsync -a "$REPO/firmware/openscore/media/" "$LED/media/"
[ -e "$LED/setting.ini" ] || install -m 0644 "$REPO/firmware/openscore/setting-point-hub.ini" "$LED/setting.ini"
install -m 0755 "$HERE/startled" "$LED/bin/startled"
WORK=$(mktemp -d)
(cd "$REPO/firmware/flushbuffer" && WORK="$WORK" BACKEND=piomatter ./build.sh)
BIN=$(ls "$WORK"/Adafruit_Blinka_Raspberry_Pi5_Piomatter-*/flushBuffer2 2>/dev/null | head -1)
[ -x "$BIN" ] || { echo "flushBuffer2 did not build"; exit 1; }
install -m 0755 "$BIN" "$LED/bin/flushBuffer2"
rm -rf "$WORK"
chown -R "$OWNER:$OWNER" "$LED"

echo "== console and bridge"
rsync -a --delete --exclude='.git' --exclude='node_modules' --exclude='.env' --exclude='settings.json' --exclude='data' \
  "$REPO/" "$BRIDGE/"
[ -e "$BRIDGE/.env" ] || cat > "$BRIDGE/.env" <<CONF
LEDBOX_HOST=127.0.0.1
STATE_DIR=$STATE
CONF
chown -R "$OWNER:$OWNER" "$BRIDGE"
install -m 0644 "$REPO/systemd/ledbox-bridge.service" /etc/systemd/system/ledbox-bridge.service
install -d -o "$OWNER" -g "$OWNER" "$STATE" /data/screen /data/backups /data/backups/openvolley
# No board network to join, so no connect QR codes: the crest and the clock (BUILD.md section 10.1).
# The screen starts by asking: Point Hub or OpenVolley. Only on a new board: the C0270 has no screen.
[ -e "$STATE/settings.json" ] || { echo '{"idleQr":false,"screenApp":"ask"}' > "$STATE/settings.json"; chown "$OWNER:$OWNER" "$STATE/settings.json"; }

# What the screen's "Load from Wiedisync" needs: the club's board token and a scorer PIN, because the
# roster holds birthdates. Asked once; empty skips it, and OpenVolley then says what is missing.
if [ -t 0 ] && ! grep -q '^LIVE_PUBLISH_TOKEN=' "$BRIDGE/.env"; then
  read -r -s -p "Wiedisync board token (LIVE_PUBLISH_TOKEN, Enter to skip): " token; echo
  [ -z "$token" ] || { umask 077; printf 'LIVE_PUBLISH_TOKEN=%s\n' "$token" >> "$BRIDGE/.env"; }
  chown "$OWNER:$OWNER" "$BRIDGE/.env"; chmod 600 "$BRIDGE/.env"
fi
if [ -t 0 ] && ! grep -q '"scorerPin": *"[0-9]' "$STATE/settings.json"; then
  read -r -s -p "Scorer PIN for this board, 1-8 digits (Enter to skip): " pin; echo
  case "$pin" in
    '') ;;
    *[!0-9]*|?????????*) echo "Not 1-8 digits: set it later in Point Hub, Settings." ;;
    *) PIN="$pin" python3 -c 'import json,os,sys; f=sys.argv[1]; d=json.load(open(f)); d["scorerPin"]=os.environ["PIN"]; json.dump(d,open(f,"w"))' "$STATE/settings.json" ;;
  esac
fi

echo "== sudo: only what the appliance calls, nothing else"
cat > /etc/sudoers.d/020_pointhub <<CONF
$OWNER ALL=(root) NOPASSWD: /usr/bin/systemctl restart ledbox-bridge, /usr/bin/systemctl restart pointhub-led, /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /usr/bin/date -s *, /usr/sbin/fake-hwclock save
CONF
chmod 0440 /etc/sudoers.d/020_pointhub
visudo -cf /etc/sudoers.d/020_pointhub

echo "== network: built-in radio as wlan1 (client only), cable on eth0"
cat > /etc/systemd/network/10-pointhub-wlan1.link <<'CONF'
[Match]
Driver=brcmfmac
[Link]
Name=wlan1
CONF
nmcli connection delete pointhub-cable 2>/dev/null || true
nmcli connection add type ethernet con-name pointhub-cable ifname eth0 ipv4.method manual \
  ipv4.addresses 192.168.5.1/24 ipv4.never-default yes ipv6.method disabled connection.autoconnect yes
cat > /etc/dnsmasq.d/pointhub-cable.conf <<'CONF'
# The tablet on the DATA cable. No router and no DNS option: it must not route through the board.
interface=eth0
except-interface=wlan1
except-interface=tailscale0
bind-dynamic
port=0
dhcp-range=192.168.5.50,192.168.5.99,255.255.255.0,15m
dhcp-option=3
dhcp-option=6
CONF
systemctl enable dnsmasq

echo "== firewall: OpenVolley's ports on the cable only"
echo 'ETH0_EXTRA_PORTS="5173 8080"' > /etc/default/ledbox-firewall
install -m 0755 "$REPO/provisioning/ledbox-firewall.sh" /usr/local/sbin/ledbox-lan-guard.sh
install -m 0644 "$REPO/provisioning/ledbox-lan-guard.service" /etc/systemd/system/ledbox-lan-guard.service
install -m 0644 "$REPO/provisioning/ledbox-buffer-tmpfs.service" /etc/systemd/system/ledbox-buffer-tmpfs.service
install -m 0755 "$REPO/provisioning/ledbox-buffer-tmpfs.sh" /usr/local/sbin/ledbox-buffer-tmpfs.sh

echo "== services"
for u in pointhubd.service pointhub-led.service pointhub-openscore.service pointhub-screen.service \
         pointhub-screen.path pointhub-screen-restart.service pointhub-shutdown-light.service \
         pointhub-backup-stick@.service; do
  install -m 0644 "$HERE/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
systemctl enable pointhubd pointhub-led pointhub-openscore ledbox-bridge pointhub-screen pointhub-screen.path \
  pointhub-shutdown-light ledbox-lan-guard ledbox-buffer-tmpfs

cat <<DONE

Done. Reboot, then:
  /opt/pointhub/pointhubd.py probe      which small boards answer
  journalctl -u pointhubd -u pointhub-led -u pointhub-openscore -u ledbox-bridge -b
No openvolley-escoresheet_*_arm64.deb in the repo folder? Install it, the start screen offers only Point Hub until then.
Before any hall use: enable-readonly-root.sh, and README.md's security list.
DONE
