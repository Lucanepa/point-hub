#!/bin/bash
# The Point Hub board's security list before any hall use (README "Security list before any hall use"),
# as one script. Run ON the board, as root, from a terminal (it asks for the new Pi password itself):
#
#   sudo bash ledbox-bridge/provisioning/point-hub/harden-for-hall.sh            # --check: read-only
#   sudo bash ledbox-bridge/provisioning/point-hub/harden-for-hall.sh --apply
#   sudo bash ledbox-bridge/provisioning/point-hub/harden-for-hall.sh --rollback
#
#   1. SSH key-only, no root password login, and NO tunnels (no -L/-R/-D, no -J through the board,
#      no tun): the board must never be a way out to the internet, not even with a key.
#   2. The bench key comes out of authorized_keys (comment "pointhub_bench", or BENCH_KEY=<comment>).
#      Refused if it is the only key: that would lock everyone out.
#   3. A new password for the Pi user, typed by a person (never stored, never printed). It was
#      pasted in a chat once, so the old one counts as known.
#   4. The bench's blanket passwordless sudo goes (/etc/sudoers.d/010_pi-nopasswd). Only after 3,
#      and only when 020_pointhub (what the appliance itself calls) is there and valid: from then
#      on root needs that new password.
#   5. Control network only: lock-control-network.sh --apply (no forwarding, no DNS for the cable).
#
# Each step backs up what it changes (lib-provision.sh); --rollback puts the files back. Step 3 has
# no rollback: the old password is not kept anywhere.
LP_NAME=harden-for-hall
. "$(dirname "$(readlink -f "$0")")/../lib-provision.sh" || { echo "!! lib-provision.sh missing"; exit 1; }

MODE=${1:---check}
case "$MODE" in --check|--apply|--rollback) ;; *) sed -n '2,24p' "$0"; exit 2 ;; esac
lp_need_root "$MODE"

OWNER=${OWNER:-pi}
HOME_OWNER=$(getent passwd "$OWNER" | cut -d: -f6)
AK="$HOME_OWNER/.ssh/authorized_keys"
BENCH_KEY=${BENCH_KEY:-pointhub_bench}
SSHD_CONF=/etc/ssh/sshd_config.d/99-pointhub-hall.conf
NOPASSWD=/etc/sudoers.d/010_pi-nopasswd
APPSUDO=/etc/sudoers.d/020_pointhub
HERE="$(dirname "$LP_SELF")"

if [ "$MODE" = --rollback ]; then
  say "rollback"
  lp_restore; rc=$?
  sshd -t && systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null
  echo "  (a password changed in step 3 stays changed)"
  exit $rc
fi

keys() { grep -vE '^[[:space:]]*(#|$)' "$AK" 2>/dev/null | grep -E '(^|[[:space:],])(ssh-|ecdsa-|sk-)' || true; }
nkeys=$(keys | grep -c . || true)
nbench=$(keys | grep -c -- "$BENCH_KEY" || true)

say "now"
echo "  authorized_keys: $nkeys key(s), $nbench matching '$BENCH_KEY'"
echo "  sshd: password auth $(sshd -T 2>/dev/null | awk '/^passwordauthentication /{print $2}'), tcp forwarding $(sshd -T 2>/dev/null | awk '/^allowtcpforwarding /{print $2}'), tunnel $(sshd -T 2>/dev/null | awk '/^permittunnel /{print $2}')"
[ -f "$NOPASSWD" ] && echo "  !! blanket passwordless sudo: $NOPASSWD" || echo "  blanket passwordless sudo: gone"
[ -f "$APPSUDO" ] && visudo -cf "$APPSUDO" >/dev/null 2>&1 && echo "  appliance sudo ($APPSUDO): valid" || echo "  !! appliance sudo ($APPSUDO): missing or invalid — run setup-board.sh first"
echo "  $OWNER password last changed: $(chage -l "$OWNER" 2>/dev/null | awk -F': ' '/Last password change/{print $2}')"
bash "$(dirname "$HERE")/lock-control-network.sh" --check 2>/dev/null | sed -n '/kernel forwarding/p;/installed firewall/p;/dnsmasq:/p'

[ "$MODE" = --check ] && exit 0
[ -t 0 ] || { echo "!! --apply asks for the new password: run it from a terminal (ssh -t)"; exit 1; }
RC=0

say "1. SSH: keys only, no tunnels"
if [ "$nkeys" -lt 1 ]; then
  echo "  !! no usable key in $AK — not turning passwords off (that would lock everyone out)"; RC=1
else
  printf '%s\n' "# harden-for-hall.sh: keys only, and the board is never a tunnel to anywhere." \
    "PasswordAuthentication no" "KbdInteractiveAuthentication no" "PermitRootLogin no" "MaxAuthTries 3" \
    "X11Forwarding no" "AllowTcpForwarding no" "AllowStreamLocalForwarding no" "AllowAgentForwarding no" \
    "PermitTunnel no" "GatewayPorts no" | lp_put "$SSHD_CONF" 0644; w=$?
  [ $w = 1 ] && exit 1
  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || { echo "  !! sshd reload failed"; RC=1; }
    echo "  sshd: $(sshd -T | awk '/^(passwordauthentication|allowtcpforwarding|permittunnel) /{printf "%s=%s ", $1, $2}')"
  else
    echo "  !! sshd config test failed — putting it back"; lp_restore; RC=1
  fi
fi

say "2. the bench key"
if [ "$nbench" -lt 1 ]; then
  echo "  no key matching '$BENCH_KEY' — nothing to remove"
elif [ "$nbench" -ge "$nkeys" ]; then
  echo "  !! '$BENCH_KEY' is the only key — add the club's admin key first, then run this again"; RC=1
else
  lp_bak "$AK" || exit 1
  tmp=$(mktemp); grep -v -- "$BENCH_KEY" "$AK" > "$tmp" && cat "$tmp" > "$AK"; rm -f "$tmp"
  echo "  removed; $(keys | grep -c .) key(s) left"
fi

say "3. a new password for $OWNER (type it twice; it is not shown or stored)"
if passwd "$OWNER"; then PW_OK=1; else PW_OK=0; echo "  !! password not changed"; RC=1; fi

say "4. blanket passwordless sudo"
if [ ! -f "$NOPASSWD" ]; then
  echo "  already gone"
elif [ "$PW_OK" != 1 ]; then
  echo "  !! kept: no new password was set, and without it root would be out of reach"; RC=1
elif ! { [ -f "$APPSUDO" ] && visudo -cf "$APPSUDO" >/dev/null 2>&1; }; then
  echo "  !! kept: $APPSUDO missing or invalid — the appliance would lose its restart/poweroff"; RC=1
else
  lp_bak "$NOPASSWD" || exit 1
  rm -f "$NOPASSWD" && visudo -c >/dev/null && echo "  removed: root now needs the new password; the appliance keeps $APPSUDO"
fi

say "5. control network only"
bash "$(dirname "$HERE")/lock-control-network.sh" --apply || RC=1

[ "$RC" = 0 ] && echo $'\nDone. Write the new password into the club vault now.' || echo $'\n!! some steps did not complete — see !! above'
exit "$RC"
