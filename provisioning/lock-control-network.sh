#!/bin/bash
# The board's own networks are for CONTROL ONLY: a device on the C0270's Wi-Fi (ledbox_C0270, wlan0)
# or on either board's cable (eth0, 192.168.5.1) reaches the board — the console, OpenVolley — and
# never the internet, the hall network or the tailnet through it.
#
#   sudo bash ledbox-bridge/provisioning/lock-control-network.sh            # --check: read-only, shows the evidence
#   sudo bash ledbox-bridge/provisioning/lock-control-network.sh --apply
#   sudo bash ledbox-bridge/provisioning/lock-control-network.sh --rollback
#
# Three layers, each enough on its own for routed traffic:
#   1. The firewall (ledbox-firewall.sh, installed by install-firewall.sh): every packet the board
#      would forward is dropped, IPv4 and IPv6, FORWARD policy DROP. --check says whether the
#      installed firewall has it; this script does not touch netfilter.
#   2. Forwarding off in the kernel: /etc/sysctl.d/90-ledbox-no-forward.conf, applied now and at
#      every boot (net.ipv4.ip_forward=0, net.ipv6.conf.all.forwarding=0). Refused while tailscale
#      advertises routes or an exit node: then forwarding is wanted, and that is a decision for a
#      person, not for this script.
#   3. No internet names from the board's DNS: dnsmasq stops forwarding questions upstream
#      (no-resolv), so it answers only what the board itself knows (the board's own names, the
#      console's https name). Without it a device could still tunnel data through DNS questions.
#      Only when the board's OWN lookups do not go through dnsmasq (127.0.0.1 in /etc/resolv.conf):
#      otherwise the board itself would lose the internet (live scoring, schedule, clock), and this
#      says so and leaves it. A dnsmasq with port=0 (the Point Hub board's cable) answers no DNS at
#      all and needs nothing.
#
# What a device on the board's Wi-Fi still gets: the board's own pages (console :8890, OpenVolley
# :5173/:8080 where set up), DHCP, the board's own names. Nothing else.
LP_NAME=lock-control-network
. "$(dirname "$(readlink -f "$0")")/lib-provision.sh" || { echo "!! lib-provision.sh missing"; exit 1; }

MODE=${1:---check}
case "$MODE" in --check|--apply|--rollback) ;; *) sed -n '2,30p' "$0"; exit 2 ;; esac
lp_need_root "$MODE"

SYSCTL=/etc/sysctl.d/90-ledbox-no-forward.conf
DNSCONF=/etc/dnsmasq.d/ledbox-control-only.conf
FWSCRIPT=/usr/local/sbin/ledbox-lan-guard.sh

if [ "$MODE" = --rollback ]; then
  say "rollback"
  lp_restore; rc=$?
  sysctl --system >/dev/null 2>&1
  systemctl restart dnsmasq 2>/dev/null
  echo "  forwarding now: v4=$(sysctl -n net.ipv4.ip_forward) v6=$(sysctl -n net.ipv6.conf.all.forwarding)"
  echo "  the firewall's forward drop stays until: sudo bash $(dirname "$LP_SELF")/install-firewall.sh with an older ledbox-firewall.sh"
  exit $rc
fi

# Where dnsmasq gets its upstream from, and whether the board itself asks it.
board_uses_dnsmasq() { grep -qE '^\s*nameserver\s+(127\.0\.0\.1|::1)\s*$' /etc/resolv.conf 2>/dev/null; }
dnsmasq_dns_off() { grep -rqsE '^\s*port\s*=\s*0\s*$' /etc/dnsmasq.conf /etc/dnsmasq.d/; }
dnsmasq_forwards() {
  grep -rqsE '^\s*no-resolv\b' /etc/dnsmasq.conf /etc/dnsmasq.d/ && ! grep -rqsE '^\s*server\s*=\s*[0-9a-fA-F:.]' /etc/dnsmasq.conf /etc/dnsmasq.d/ && return 1
  return 0
}
ts_routes() { command -v tailscale >/dev/null 2>&1 && tailscale debug prefs 2>/dev/null | grep -E '"(AdvertiseRoutes|AdvertiseExitNode)"' | grep -vE '": (null|false|\[\])' ; }

say "now"
echo "  kernel forwarding: v4=$(sysctl -n net.ipv4.ip_forward 2>/dev/null) v6=$(sysctl -n net.ipv6.conf.all.forwarding 2>/dev/null) (0 = off)"
if [ -r "$FWSCRIPT" ] && grep -q 'LEDBOX-FWD' "$FWSCRIPT"; then
  echo "  installed firewall drops forwarding: yes"
else
  echo "  installed firewall drops forwarding: NO — run install-firewall.sh (then --commit) with the current ledbox-firewall.sh"
fi
echo "  FORWARD v4: $(iptables -w 5 -S FORWARD 2>/dev/null | head -2 | tr '\n' ' ')"
echo "  FORWARD v6: $(ip6tables -w 5 -S FORWARD 2>/dev/null | head -2 | tr '\n' ' ')"
nat=$(iptables -w 5 -t nat -S POSTROUTING 2>/dev/null | grep -E 'MASQUERADE|SNAT' || true)
[ -n "$nat" ] && { echo "  NAT rules present (harmless once nothing is forwarded):"; echo "$nat" | sed 's/^/    /'; } || echo "  NAT: none"
r=$(ts_routes || true)
[ -n "$r" ] && { echo "  !! tailscale advertises routes / an exit node:"; echo "$r" | sed 's/^/    /'; } || echo "  tailscale: no routes, no exit node advertised"
if dnsmasq_dns_off; then
  echo "  dnsmasq: answers no DNS (port=0) — nothing to do"
elif dnsmasq_forwards; then
  echo "  dnsmasq: FORWARDS questions upstream (internet names resolve for devices on the board's networks)"
else
  echo "  dnsmasq: answers only local names (no-resolv)"
fi
board_uses_dnsmasq && echo "  the board's own lookups go through dnsmasq (127.0.0.1 in /etc/resolv.conf)" \
  || echo "  the board's own lookups do not go through dnsmasq: $(grep -E '^\s*nameserver' /etc/resolv.conf 2>/dev/null | tr '\n' ' ')"
for f in /etc/dnsmasq.conf /etc/dnsmasq.d/*; do
  [ -f "$f" ] || continue
  grep -HnE '^\s*(dhcp-option|interface|server|no-resolv|address|port)\b' "$f" 2>/dev/null | sed 's/^/    /'
done

[ "$MODE" = --check ] && exit 0

say "1+2. kernel forwarding off"
if [ -n "$(ts_routes || true)" ]; then
  echo "  !! not turning forwarding off: tailscale advertises routes or an exit node (see above)."
  echo "     Decide first; the firewall's forward drop already blocks routed traffic either way."
else
  printf '# lock-control-network.sh: the board routes nothing (its Wi-Fi and cable are control only).\nnet.ipv4.ip_forward=0\nnet.ipv6.conf.all.forwarding=0\n' \
    | lp_put "$SYSCTL" 0644; [ $? = 1 ] && exit 1
  sysctl -p "$SYSCTL" >/dev/null && echo "  applied: v4=$(sysctl -n net.ipv4.ip_forward) v6=$(sysctl -n net.ipv6.conf.all.forwarding)"
fi

say "3. DNS: local names only"
if dnsmasq_dns_off; then
  echo "  dnsmasq answers no DNS — nothing to do"
elif board_uses_dnsmasq; then
  echo "  !! left as it is: the board's own lookups go through dnsmasq, and no-resolv would cut the board"
  echo "     off the internet too. Routed traffic is still blocked (layers 1+2); only DNS questions pass."
else
  printf '# lock-control-network.sh: answer only the board'"'"'s own names; never ask upstream for a device on the\n# board'"'"'s Wi-Fi or cable (no internet, no DNS tunnel). The board'"'"'s own lookups do not use dnsmasq.\nno-resolv\nno-poll\n' \
    | lp_put "$DNSCONF" 0644; w=$?
  [ $w = 1 ] && exit 1
  if [ $w = 0 ]; then
    if dnsmasq --test >/dev/null 2>&1 && systemctl restart dnsmasq; then echo "  dnsmasq restarted: $(systemctl is-active dnsmasq)"
    else echo "  !! dnsmasq did not take it — rolling this step back"; lp_restore; systemctl restart dnsmasq; exit 1; fi
  fi
fi

say "result"
echo "  forwarding: v4=$(sysctl -n net.ipv4.ip_forward) v6=$(sysctl -n net.ipv6.conf.all.forwarding)"
grep -q 'LEDBOX-FWD' "$FWSCRIPT" 2>/dev/null || echo "  !! the installed firewall still lacks the forward drop: run install-firewall.sh, verify, --commit"
echo "  test from a phone on the board's Wi-Fi with mobile data OFF: a website must not open; the console must."
