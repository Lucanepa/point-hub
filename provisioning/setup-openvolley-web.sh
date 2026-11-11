#!/bin/bash
# OpenVolley on the C0270: the board serves OpenVolley's web app and relay itself, so a tablet or a
# phone on the board's Wi-Fi scores in OpenVolley with no laptop and no internet, and the panel
# follows (Link mode's default relay is ws://127.0.0.1:8080). docs/openvolley-link-DESIGN.md.
#
#   sudo bash ledbox-bridge/provisioning/setup-openvolley-web.sh             # --check: read-only
#   sudo bash ledbox-bridge/provisioning/setup-openvolley-web.sh --apply
#   sudo bash ledbox-bridge/provisioning/setup-openvolley-web.sh --rollback  # unit + ports back out
#
# Needs the bundle first: tools/build-openvolley-web.sh <version> on a laptop, then deploy-board.sh,
# which unpacks it into /home/pi/openvolley-web/<version> and points `current` at it.
#
# --apply:
#   1. installs pointhub-openvolley.service (next to this script) and enables + starts it
#   2. adds 5173 and 8080 to WLAN0_EXTRA_PORTS and ETH0_EXTRA_PORTS in /etc/default/ledbox-firewall
#      (the AP and the cable; never wlan1, the hall) — the firewall itself is NOT reloaded here:
#      a default-deny ruleset goes live only through install-firewall.sh and its auto-rollback,
#      and the installed copy may predate WLAN0_EXTRA_PORTS. This prints the two commands.
#   3. sets BOARD_OPENVOLLEY=1 in ledbox-bridge's .env: the panel follows the one live match on the
#      board's relay by itself (used at the bridge's next start; never restarted from here)
#   4. checks /api/server/status on 127.0.0.1:5173
#
# NOT for the Point Hub DIY board: OpenVolley runs on its own screen there and already owns 5173 and
# 8080 (setup-board.sh). It refuses a board that has pointhub-screen installed.

LP_NAME=setup-openvolley-web
. "$(dirname "$(readlink -f "$0")")/lib-provision.sh" || { echo "!! lib-provision.sh missing"; exit 1; }

MODE=${1:---check}
case "$MODE" in --check|--apply|--rollback) ;; *) sed -n '2,23p' "$0"; exit 2 ;; esac
lp_need_root "$MODE"

HERE="$(dirname "$LP_SELF")"
UNIT=pointhub-openvolley.service
UNIT_DST=/etc/systemd/system/$UNIT
WEB=/home/pi/openvolley-web/current
DEFAULTS=/etc/default/ledbox-firewall
PORTS="5173 8080"
ENVF=/home/pi/ledbox-bridge/.env

if [ "$MODE" = --rollback ]; then
  say "rollback"
  systemctl disable --now "$UNIT" >/dev/null 2>&1 && echo "  $UNIT stopped and disabled"
  lp_restore; rc=$?
  systemctl daemon-reload
  echo "  the firewall keeps its live rules until: sudo bash $HERE/install-firewall.sh (then --commit)"
  exit $rc
fi

# The value of VAR in the defaults file with PORTS added (order kept, no duplicates).
merged() { # merged <VAR>
  local cur
  cur=$(sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" "$DEFAULTS" 2>/dev/null | tail -1)
  printf '%s %s\n' "$cur" "$PORTS" | tr ' ' '\n' | awk 'NF && !seen[$0]++' | paste -sd' '
}

say "preflight"
BLOCK=0
if systemctl cat pointhub-screen.service >/dev/null 2>&1; then
  echo "  !! this is a Point Hub board (pointhub-screen installed): OpenVolley runs on its screen; not for here"
  BLOCK=1
fi
[ -x /opt/nodejs/bin/node ] && echo "  node: $(/opt/nodejs/bin/node -v)" || { echo "  !! no /opt/nodejs/bin/node"; BLOCK=1; }
if [ -f "$WEB/server.js" ]; then
  echo "  bundle: $(readlink -f "$WEB") ($(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$WEB/BUILD.json" 2>/dev/null | head -1))"
else
  echo "  !! no $WEB/server.js — build with tools/build-openvolley-web.sh and run deploy-board.sh first"
  BLOCK=1
fi
[ -r "$HERE/$UNIT" ] || { echo "  !! no $HERE/$UNIT"; BLOCK=1; }
busy=$(ss -Hltnp 2>/dev/null | awk '$4 ~ /:(5173|8080)$/' | grep -v 'node' || true)
[ -z "$busy" ] || { echo "  !! 5173/8080 already taken by something else:"; echo "$busy" | sed 's/^/    /'; BLOCK=1; }
grep -q WLAN0_EXTRA_PORTS /usr/local/sbin/ledbox-lan-guard.sh 2>/dev/null \
  && echo "  installed firewall knows WLAN0_EXTRA_PORTS" \
  || echo "  installed firewall predates WLAN0_EXTRA_PORTS: run install-firewall.sh after --apply (printed below)"
echo "  $DEFAULTS will have: WLAN0_EXTRA_PORTS=\"$(merged WLAN0_EXTRA_PORTS)\" ETH0_EXTRA_PORTS=\"$(merged ETH0_EXTRA_PORTS)\""
echo "  $UNIT: $(systemctl is-enabled "$UNIT" 2>/dev/null || echo not installed), $(systemctl is-active "$UNIT" 2>/dev/null)"

if [ "$MODE" = --check ]; then
  [ "$BLOCK" = 0 ] && echo && echo "  ready: sudo bash $LP_SELF --apply"
  exit "$BLOCK"
fi
[ "$BLOCK" = 0 ] || { echo; echo "!! not applying (see above)"; exit 1; }

say "1) service"
lp_put "$UNIT_DST" 0644 < "$HERE/$UNIT"; [ $? = 1 ] && exit 1
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null 2>&1 && echo "  enabled"
systemctl restart "$UNIT" && echo "  started"

say "2) firewall defaults"
{
  [ -f "$DEFAULTS" ] && grep -v -e '^WLAN0_EXTRA_PORTS=' -e '^ETH0_EXTRA_PORTS=' "$DEFAULTS"
  echo "WLAN0_EXTRA_PORTS=\"$(merged WLAN0_EXTRA_PORTS)\""
  echo "ETH0_EXTRA_PORTS=\"$(merged ETH0_EXTRA_PORTS)\""
} | lp_put "$DEFAULTS" 0644; [ $? = 1 ] && exit 1

say "3) the bridge follows the board's own match (BOARD_OPENVOLLEY=1 in $ENVF)"
if grep -qx 'BOARD_OPENVOLLEY=1' "$ENVF" 2>/dev/null; then
  echo "  unchanged: $ENVF"
else
  # Edited in place, not through lp_put: .env belongs to pi, and lp_put writes root-owned files.
  lp_bak "$ENVF" || exit 1
  [ -f "$ENVF" ] || install -o pi -g pi -m 0600 /dev/null "$ENVF"
  sed -i '/^BOARD_OPENVOLLEY=/d' "$ENVF"
  printf 'BOARD_OPENVOLLEY=1\n' >> "$ENVF"
  echo "  wrote BOARD_OPENVOLLEY=1 — takes effect at the bridge's next start (a deploy or a reboot),"
  echo "  or now, between matches: sudo systemctl restart ledbox-bridge"
fi

say "4) verify"
rc=1
for _ in $(seq 1 40); do
  if /opt/nodejs/bin/node -e 'fetch("http://127.0.0.1:5173/api/server/status").then(r=>r.json()).then(s=>{if(!s.running)process.exit(1);console.log("  relay running, ws "+s.wsPort+", "+(s.localIP||"?"))}).catch(()=>process.exit(1))' 2>/dev/null; then
    rc=0; break
  fi
  sleep 0.5
done
[ "$rc" = 0 ] || { echo "  !! no answer on 127.0.0.1:5173 — journalctl -u $UNIT"; exit 1; }

cat <<DONE

Done. Open the ports on the AP and the cable (auto-rollback in 240 s unless committed):
  sudo bash $HERE/install-firewall.sh
  # from a phone on the board's Wi-Fi: http://172.24.1.1:5173 opens OpenVolley, then:
  sudo bash $HERE/install-firewall.sh --commit
DONE
