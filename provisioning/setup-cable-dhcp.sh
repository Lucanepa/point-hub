#!/bin/bash
# DHCP on the board's network port (eth0, 192.168.5.1), so the console tablet works over a cable.
#
# ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
# │ The board's network port is for the console tablet (USB-C Ethernet adapter) or a laptop, and │
# │ NOTHING ELSE. Never plug it into a hall or school network switch: the board would hand out   │
# │ addresses on that network, and the appliance trusts a client on the cable without the scorer │
# │ PIN (192.168.5.0/24 on 192.168.5.1) — that whole network would be trusted.                   │
# └──────────────────────────────────────────────────────────────────────────────────────────────┘
#
# The tablet's cable path (the app binds TRANSPORT_ETHERNET and loads http://192.168.5.1:8890) has
# never worked, because nothing on the wire gives the tablet an address: dnsmasq is bound to the AP
# (harden-board.sh) and Android's Ethernet only does DHCP. This adds, as one dnsmasq drop-in:
#
#   interface=eth0                     dnsmasq serves eth0 as well as wlan0 — never wlan1 (the
#   except-interface=wlan1             house/hall uplink) and never tailscale0
#   except-interface=tailscale0
#   dhcp-range 192.168.5.50-99, 15 min a short lease: a tablet that leaves gives its address back soon
#   NO router option (dhcp-option 3)   the tablet must never route its internet through the board
#   NO DNS option (dhcp-option 6)      the board answers no DNS on the cable (the firewall keeps :53
#                                      closed on eth0), so the app falls back to the plain
#                                      http://192.168.5.1:8890 — which is also what cable trust
#                                      needs: it holds only for requests arriving on 192.168.5.1
#
# dnsmasq does listen for DNS on 192.168.5.1 once eth0 is one of its interfaces — there is no
# DHCP-only switch per interface — but ledbox-firewall.sh accepts nothing on eth0 :53, so nothing
# reaches it. What the firewall must accept is udp/67 on eth0 (added next to the wlan0 line in
# ledbox-firewall.sh); without it the tablet's DISCOVER never arrives. Install that with
# install-firewall.sh first — --check says whether it is live.
#
# --check first, and it refuses --apply unless:
#   - eth0 is still the static 192.168.5.1/24 (a DHCP client and server on one wire is a mess)
#   - nothing on the wire already sits in .50-.99 (the old openvolley Pi link, if plugged in)
#   - no other DHCP server answers on eth0 (probed with busybox udhcpc when there is a link and
#     busybox — it asks only, it configures nothing)
# The openvolley Pi itself cannot be seen from here when it is unplugged: if it is ever cabled to
# eth0 again it must keep a STATIC address outside .50-.99 and must not run a DHCP server there.
#
#   sudo bash ledbox-bridge/provisioning/setup-cable-dhcp.sh            # --check: read-only
#   sudo bash ledbox-bridge/provisioning/setup-cable-dhcp.sh --apply
#   sudo bash ledbox-bridge/provisioning/setup-cable-dhcp.sh --rollback # dnsmasq back to the AP only
#
# Restarting dnsmasq blips DNS/DHCP on the AP for about a second; associated tablets keep their
# leases. Run it with no match on.
set -uo pipefail

LP_NAME=setup-cable-dhcp
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
. "$HERE/lib-provision.sh" || { echo "!! lib-provision.sh missing next to $0"; exit 1; }

MODE=${1:---check}
case "$MODE" in --check|--apply|--rollback) ;; *) sed -n '2,46p' "$0"; exit 2 ;; esac
lp_need_root "$MODE"

CONF=/etc/dnsmasq.d/ledbox-cable-dhcp.conf
ADDR=192.168.5.1
LO=50; HI=99
RC=0
BLOCK=0          # set by preflight: 1 = --apply must not go ahead

in_range() { local o=${1##*.}; [ "${1%.*}" = 192.168.5 ] && [ "$o" -ge "$LO" ] && [ "$o" -le "$HI" ]; }

preflight() {
  say "eth0 — must be the static $ADDR/24"
  local prof method addrs gw
  prof=$(nmcli -t -f NAME,DEVICE,TYPE connection show 2>/dev/null | awk -F: '$2=="eth0"{print $1; exit}')
  [ -z "$prof" ] && prof=$(nmcli -t -f NAME,TYPE connection show 2>/dev/null | awk -F: '$2 ~ /ethernet/{print $1}' \
    | while read -r p; do [ "$(nmcli -g connection.interface-name connection show "$p" 2>/dev/null)" = eth0 ] && echo "$p"; done | head -1)
  if [ -n "$prof" ]; then
    method=$(nmcli -g ipv4.method connection show "$prof" 2>/dev/null)
    addrs=$(nmcli -g ipv4.addresses connection show "$prof" 2>/dev/null)
    gw=$(nmcli -g ipv4.gateway connection show "$prof" 2>/dev/null)
    echo "  NetworkManager profile '$prof': method=$method addresses=$addrs gateway=${gw:-none} metric=$(nmcli -g ipv4.route-metric connection show "$prof" 2>/dev/null)"
    [ "$method" = manual ] || { echo "  !! eth0 is not static (method=$method) — the board would be DHCP client and server on one wire"; BLOCK=1; }
    case ",$addrs," in *",$ADDR/24,"*|*", $ADDR/24,"*) ;; *) echo "  !! $ADDR/24 is not among eth0's addresses ($addrs)"; BLOCK=1 ;; esac
    if [ -n "$gw" ] && in_range "$gw"; then echo "  !! eth0's gateway $gw (the old Pi link) sits inside .$LO-.$HI"; BLOCK=1; fi
  else
    echo "  no NetworkManager profile for eth0 — looking elsewhere:"
    grep -rsn 'eth0' /etc/network/interfaces /etc/network/interfaces.d /etc/dhcpcd.conf /etc/systemd/network 2>/dev/null | sed 's/^/    /'
    echo "  !! cannot confirm a static $ADDR/24 on eth0 — not applying"; BLOCK=1
  fi
  echo "  carrier: $(cat /sys/class/net/eth0/carrier 2>/dev/null || echo '?')   now: $(ip -4 -o addr show eth0 2>/dev/null | awk '{print $4}' | tr '\n' ' ')(no address is normal with nothing plugged in)"

  say "who else is on the wire"
  local n
  while read -r n _; do
    [ -n "$n" ] || continue
    if in_range "$n"; then echo "  !! $n is on eth0 and inside .$LO-.$HI"; BLOCK=1; else echo "  neighbour $n"; fi
  done < <(ip -4 neigh show dev eth0 2>/dev/null)
  if [ "$(cat /sys/class/net/eth0/carrier 2>/dev/null)" = 1 ]; then
    if command -v busybox >/dev/null && busybox --list 2>/dev/null | grep -qx udhcpc; then
      # -s /bin/true: the lease script is what would configure the interface; this one does nothing.
      local out; out=$(timeout 15 busybox udhcpc -i eth0 -n -q -t 3 -T 2 -s /bin/true 2>&1)
      if grep -qiE "lease of .* from $ADDR([^0-9]|$)" <<<"$out"; then
        echo "  the only DHCP server answering on eth0 is this board ($ADDR) — already applied"
      elif grep -qiE 'lease of|obtained' <<<"$out"; then
        echo "  !! another DHCP server answered on eth0:"; sed 's/^/     /' <<<"$out" | tail -3; BLOCK=1
      else
        echo "  no other DHCP server answered on eth0"
      fi
    else
      echo "  (no busybox udhcpc to probe for another DHCP server — check what is plugged in: neighbours above)"
    fi
  else
    echo "  nothing plugged into eth0 — no other DHCP server can be on the wire right now"
  fi

  say "dnsmasq now"
  echo "  dnsmasq: $(systemctl is-active dnsmasq 2>/dev/null)"
  grep -hsE '^\s*(interface|except-interface|no-dhcp-interface|listen-address|bind-[a-z]+|dhcp-range|dhcp-option)=?' \
    /etc/dnsmasq.conf /etc/dnsmasq.d/* 2>/dev/null | sed 's/^/  /'
  echo "  :67 owner: $(ss -ulpnH 'sport = :67' 2>/dev/null | grep -o 'users:(("[^"]*"' | sort -u | tr '\n' ' ')"
  echo "  :53 bound on: $(ss -ulnH 'sport = :53' 2>/dev/null | awk '{print $4}' | tr '\n' ' ')"

  say "firewall"
  if iptables -w 5 -S LEDBOX-IN 2>/dev/null | grep -qE -- '-i eth0 -p udp( -m udp)? --dport 67 -j ACCEPT'; then
    echo "  udp/67 on eth0: accepted"
  else
    echo "  !! udp/67 on eth0 is NOT accepted yet — install the updated ledbox-firewall.sh first:"
    echo "       sudo bash ledbox-bridge/provisioning/install-firewall.sh   (then --commit once verified)"
    echo "     (DHCP on eth0 is harmless without it — it just never answers)"
  fi
  iptables -w 5 -S LEDBOX-IN 2>/dev/null | grep -qE -- '-i eth0 .*--dport 53 ' && echo "  !! the firewall accepts :53 on eth0 — not expected"
}

apply() {
  [ "$BLOCK" = 0 ] || { echo; echo "!! not applying — see the !! lines above"; RC=1; return; }
  say "dnsmasq — DHCP on eth0 too"
  lp_put "$CONF" 0644 <<EOF
# Written by point-hub provisioning/setup-cable-dhcp.sh — DHCP for the console tablet on the cable.
# THE BOARD'S NETWORK PORT IS FOR THE TABLET OR A LAPTOP ONLY. Never cable it into a hall/school
# switch: this would hand out addresses there, and the appliance trusts 192.168.5.0/24 without a PIN.
interface=eth0
except-interface=wlan1
except-interface=tailscale0
dhcp-range=set:cable,192.168.5.$LO,192.168.5.$HI,255.255.255.0,15m
# No default route and no DNS server for cable clients: an empty option is not sent at all.
dhcp-option=tag:cable,3
dhcp-option=tag:cable,6
EOF
  case $? in 1) RC=1; return ;; 2) echo "  already in place"; return ;; esac
  # Debian's own check (dnsmasq --test with the conf-dir the service really uses) before a restart.
  # bookworm ships it as systemd-helper, older releases in the init script. The unit's own
  # ExecStartPre runs the same check, so a restart below would fail on a bad config either way.
  local chk=""
  for c in /usr/share/dnsmasq/systemd-helper /etc/init.d/dnsmasq; do [ -x "$c" ] && { chk=$c; break; }; done
  if [ -n "$chk" ] && ! "$chk" checkconfig >/dev/null 2>&1; then
    echo "  !! dnsmasq rejects the config — putting it back"; "$chk" checkconfig 2>&1 | tail -3 | sed 's/^/     /'
    lp_restore >/dev/null; RC=1; return
  fi
  if ! systemctl restart dnsmasq || ! sleep 2 || ! systemctl is-active --quiet dnsmasq; then
    echo "  !! dnsmasq did not come back — putting the old config back"
    journalctl -u dnsmasq -n 8 --no-pager 2>/dev/null | sed 's/^/     /'
    lp_restore >/dev/null; systemctl restart dnsmasq
    echo "  dnsmasq after restore: $(systemctl is-active dnsmasq)"; RC=1; return
  fi
  echo "  dnsmasq: active"
  local w1; w1=$(ip -4 -o addr show wlan1 2>/dev/null | awk '{split($4,a,"/"); print a[1]}')
  if [ -n "$w1" ] && ss -ulnH 'sport = :53' 2>/dev/null | awk '{print $4}' | grep -q "^$w1:"; then
    echo "  !! dnsmasq listens on wlan1's address $w1 — rolling back"; lp_restore >/dev/null; systemctl restart dnsmasq; RC=1; return
  fi
  echo "  :53 bound on: $(ss -ulnH 'sport = :53' 2>/dev/null | awk '{print $4}' | tr '\n' ' ') (wlan1 not among them)"
  echo "  test: tablet Wi-Fi OFF, adapter + cable into the board → the app loads http://192.168.5.1:8890"
  echo "  leases: grep 192.168.5. /var/lib/misc/dnsmasq.leases"
}

case "$MODE" in
  --check) preflight; [ "$BLOCK" = 0 ] && echo $'\n'"  OK to --apply" || echo $'\n'"  !! --apply would refuse (see !! above)" ;;
  --apply) preflight; apply; [ -n "$LP_RUN" ] && echo "  backups: $LP_RUN   (undo: --rollback)" ;;
  --rollback)
    say "rollback — dnsmasq back to how it was"
    lp_restore || RC=1
    systemctl restart dnsmasq; sleep 2; echo "  dnsmasq: $(systemctl is-active dnsmasq)"
    ;;
esac
exit "$RC"
