#!/bin/bash
# Restrict what the LedBox board exposes on its NEW wifi uplink (wlan1 / home LAN).
#
# Gaining a home-LAN address put these on every device's reach: apache2 :80 (Tech4Sport web admin,
# still on vendor default credentials), :8889 + :12345 (unauthenticated scoreboard control), dnsmasq :53 (open
# resolver). Before the uplink they were only on the Pi link and the board's own AP.
#
# Scoped to `-i wlan1` ONLY. The AP (172.24.1.0/24), the Pi link (192.168.5.0/24) and tailscale0
# are deliberately untouched — the console and the bridge keep working exactly as before.
# :8890 (PIN-protected console) and :22 stay reachable from the LAN, on purpose.
#
# Installed as a unit because a hand-added iptables rule is what silently died on the last reboot
# and took the board's clock with it. Idempotent: `-C || -A`, safe to re-run.
set -euo pipefail

install -m 0755 /dev/stdin /usr/local/sbin/ledbox-lan-guard.sh <<'GUARD'
#!/bin/bash
# Applied at boot by ledbox-lan-guard.service. Idempotent.
set -u
UPLINK=wlan1

add4() { iptables  -C "$@" 2>/dev/null || iptables  -A "$@"; }
add6() { ip6tables -C "$@" 2>/dev/null || ip6tables -A "$@"; }

for f in add4 add6; do
  # Vendor surfaces: web admin (ships on default credentials) + raw scoreboard control. No auth.
  $f INPUT -i "$UPLINK" -p tcp -m multiport --dports 80,8889,12345 -j DROP
  # dnsmasq serves the board's own AP clients; it must not answer the home LAN.
  # Only inbound queries TO port 53 are dropped — replies to the board's own outbound
  # lookups come back on an ephemeral port and are unaffected.
  $f INPUT -i "$UPLINK" -p udp --dport 53 -j DROP
  $f INPUT -i "$UPLINK" -p tcp --dport 53 -j DROP
done
GUARD

install -m 0644 /dev/stdin /etc/systemd/system/ledbox-lan-guard.service <<'UNIT'
[Unit]
Description=LedBox: restrict vendor services on the wifi uplink (wlan1)
After=network-online.target NetworkManager.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/ledbox-lan-guard.sh

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now ledbox-lan-guard.service

echo "=== unit ==="
systemctl is-enabled ledbox-lan-guard.service
systemctl is-active  ledbox-lan-guard.service
echo
echo "=== INPUT chain now ==="
iptables -S INPUT
echo
echo "=== idempotency check (re-run must not duplicate) ==="
BEFORE=$(iptables -S INPUT | wc -l)
/usr/local/sbin/ledbox-lan-guard.sh
AFTER=$(iptables -S INPUT | wc -l)
echo "  rules before=$BEFORE after=$AFTER"
[ "$BEFORE" = "$AFTER" ] && echo "  OK idempotent" || echo "  !! rules duplicated on re-run"
