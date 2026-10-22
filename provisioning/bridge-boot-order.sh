#!/bin/bash
# Measure the boot, and stop the bridge waiting for "network online" when it does not need to.
#
# ledbox-bridge.service had After=/Wants=network-online.target. The Wants= is what pulls
# NetworkManager-wait-online into every boot, and the After= makes the bridge — the console the
# volunteer is waiting for — sit behind it: nm-online --wait-for-startup waits until every
# autoconnect profile in range has been tried (house Wi-Fi, Free_WLAN_KTZH, the 802.1X hall-login
# with its 12 s auth timeout), capped at NM_ONLINE_TIMEOUT=60 s in current NetworkManager.
#
# The bridge needs none of it. It listens on 0.0.0.0 (src/appliance.js), reaches the panel over
# loopback, and its network paths — live push, the season schedule, the relay search, clock sync —
# all retry on their own. ledbox-tls-renew keeps its own Wants=network-online.target (it is the one
# thing that really needs the internet, and it runs later from its timer).
#
# A hypothesis until measured (research compute-08 / system-06), so --check MEASURES: the critical
# chain of the bridge and rc-local (the vendor panel start), the slowest units, and who else pulls
# network-online.target in. Apply only if the bridge's chain shows NetworkManager-wait-online taking
# more than ~10 s; then reboot cold and measure again. The gain is 10-20 s at most, and the 45 s
# cold-boot figure in the hall guide (STATUS.md) is only updated after measuring.
#
# Debian's systemd also orders rc-local.service After=network-online.target (a drop-in). That is
# ordering only: once nothing Wants the target any more, it is not in the boot and rc-local stops
# waiting too — unless --check lists another unit that still pulls it in.
#
# Takes effect at the next boot; nothing is restarted.
#
#   sudo bash ledbox-bridge/provisioning/bridge-boot-order.sh            # --check: measure, read-only
#   sudo bash ledbox-bridge/provisioning/bridge-boot-order.sh --apply    # After=network.target, no Wants
#   sudo bash ledbox-bridge/provisioning/bridge-boot-order.sh --rollback # the unit as it was
set -uo pipefail

LP_NAME=bridge-boot-order
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
. "$HERE/lib-provision.sh" || { echo "!! lib-provision.sh missing next to $0"; exit 1; }

MODE=${1:---check}
case "$MODE" in --check|--apply|--rollback) ;; *) sed -n '2,30p' "$0"; exit 2 ;; esac
lp_need_root "$MODE"
RC=0

unit_file() { systemctl show -p FragmentPath --value ledbox-bridge 2>/dev/null; }

check() {
  say "ledbox-bridge ordering"
  echo "  unit:  $(unit_file)"
  echo "  After: $(systemctl show -p After --value ledbox-bridge | tr ' ' '\n' | grep -E 'network' | tr '\n' ' ')"
  echo "  Wants: $(systemctl show -p Wants --value ledbox-bridge | tr ' ' '\n' | grep -E 'network' | tr '\n' ' ')"
  local d; d=$(systemctl show -p DropInPaths --value ledbox-bridge)
  [ -n "$d" ] && echo "  drop-ins: $d"
  say "this boot"
  systemd-analyze 2>/dev/null | sed 's/^/  /'
  echo "  -- critical chain of ledbox-bridge (@ = started at, + = took):"
  systemd-analyze critical-chain ledbox-bridge.service 2>/dev/null | sed 1,2d | sed 's/^/  /'
  echo "  -- critical chain of rc-local (the vendor app + panel start):"
  systemd-analyze critical-chain rc-local.service 2>/dev/null | sed 1,2d | sed 's/^/  /'
  echo "  -- slowest units:"
  systemd-analyze blame 2>/dev/null | head -8 | sed 's/^/  /'
  say "who pulls network-online.target into the boot"
  systemctl list-dependencies --reverse --plain network-online.target 2>/dev/null | sed 1d | sed 's/^/  /'
  echo "  NetworkManager-wait-online: $(systemctl is-enabled NetworkManager-wait-online 2>/dev/null), took $(systemd-analyze blame 2>/dev/null | awk '/NetworkManager-wait-online/{print $1}' | head -1)"
  if systemd-analyze critical-chain ledbox-bridge.service 2>/dev/null | grep -q 'network-online'; then
    echo "  → the bridge's start DOES wait on network-online this boot"
  else
    echo "  → the bridge's start does not wait on network-online this boot"
  fi
}

apply() {
  say "ledbox-bridge: After=network.target, no Wants=network-online.target"
  local f; f=$(unit_file)
  [ -f "$f" ] || { echo "  !! no unit file for ledbox-bridge"; RC=1; return; }
  local tmp; tmp=$(mktemp) || { RC=1; return; }
  # Token-wise on the After=/Wants= lines only; a Wants= left empty is dropped.
  awk '
    /^[[:space:]]*After=/  { gsub(/network-online\.target/, "network.target") }
    /^[[:space:]]*Wants=/  { gsub(/[[:space:]]*network-online\.target/, ""); if ($0 ~ /^[[:space:]]*Wants=[[:space:]]*$/) next }
    { print }' "$f" > "$tmp"
  if cmp -s "$tmp" "$f"; then rm -f "$tmp"; echo "  already so — nothing written"; else
    diff -U0 "$f" "$tmp" | grep -E '^[+-][A-Z]' | sed 's/^/  /'
    lp_bak "$f" || { rm -f "$tmp"; RC=1; return; }
    cat "$tmp" > "$f" && rm -f "$tmp"
    systemctl daemon-reload || RC=1
  fi
  local d; d=$(systemctl show -p DropInPaths --value ledbox-bridge)
  [ -n "$d" ] && grep -ls 'network-online' $d 2>/dev/null | sed 's/^/  !! a drop-in still names network-online: /'
  echo "  now After: $(systemctl show -p After --value ledbox-bridge | tr ' ' '\n' | grep -E 'network' | tr '\n' ' ')"
  echo "  now Wants: $(systemctl show -p Wants --value ledbox-bridge | tr ' ' '\n' | grep -E 'network' | tr '\n' ' ')"
  echo "  takes effect at the next boot. Measure again after a COLD start (power off/on):  --check"
}

case "$MODE" in
  --check) check ;;
  --apply) apply ;;
  --rollback) say "rollback"; lp_restore || RC=1; systemctl daemon-reload ;;
esac
exit "$RC"
