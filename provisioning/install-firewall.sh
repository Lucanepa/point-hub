#!/bin/bash
# Install the default-deny firewall WITH AN AUTO-ROLLBACK.
#
# A default-deny INPUT policy applied over SSH is the classic way to lock yourself out of a
# device. So: snapshot the current rules, arm a detached timer that restores them in 240s, then
# apply. If the new rules cut our own access, the timer undoes them and the board comes back on
# its own. If verification passes, `--commit` disarms the timer and makes the rules permanent.
set -uo pipefail

SNAP4=/var/tmp/ledbox-fw-before.v4
SNAP6=/var/tmp/ledbox-fw-before.v6
SENTINEL=/var/tmp/ledbox-fw-commit
TARGET=/usr/local/sbin/ledbox-lan-guard.sh
GRACE=240

case "${1:-apply}" in
  --commit)
    touch "$SENTINEL"
    echo "  committed — auto-rollback disarmed"
    # Persist: the unit already points at $TARGET and is enabled, so a reboot re-applies it.
    systemctl is-enabled ledbox-lan-guard.service
    exit 0 ;;

  --rollback-now)
    /usr/sbin/iptables-restore  < "$SNAP4"
    /usr/sbin/ip6tables-restore < "$SNAP6"
    echo "  rolled back to the snapshot"
    exit 0 ;;
esac

rm -f "$SENTINEL"
/usr/sbin/iptables-save  > "$SNAP4"
/usr/sbin/ip6tables-save > "$SNAP6"
echo "  snapshot saved ($(grep -c . "$SNAP4") v4 lines, $(grep -c . "$SNAP6") v6 lines)"

# Detached so it survives this SSH session ending — which is exactly the case where it is needed.
setsid nohup bash -c "
  sleep $GRACE
  [ -f '$SENTINEL' ] && exit 0
  /usr/sbin/iptables-restore  < '$SNAP4'
  /usr/sbin/ip6tables-restore < '$SNAP6'
  logger -t ledbox-fw 'AUTO-ROLLBACK fired: new firewall was never committed'
" >/dev/null 2>&1 </dev/null &
echo "  auto-rollback armed: ${GRACE}s unless committed"

install -m 0755 /tmp/ledbox-firewall.sh "$TARGET"
echo "  installed $TARGET"
"$TARGET"
