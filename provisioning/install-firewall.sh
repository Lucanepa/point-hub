#!/bin/bash
# Install the default-deny firewall WITH AN AUTO-ROLLBACK.
#
# A default-deny INPUT policy applied over SSH is the classic way to lock yourself out of a
# device. So: snapshot the current rules, arm a timer that restores them in 240s, then apply.
# If the new rules cut our own access, the timer undoes them and the board comes back on its
# own. If verification passes, `--commit` disarms the timer and makes the rules permanent.
#
# The rollback has TWO independent legs, because the old one had a hole big enough to brick the
# board: a `setsid nohup … sleep 240` dies with a reboot while the ruleset it was guarding lives
# on, so rebooting inside the grace window was an unrecoverable lockout — the exact outcome this
# script exists to prevent.
#   1. session leg — a transient systemd timer, which survives the SSH session ending (the case
#      the detached sleep was reaching for) and is visible and cancellable, unlike a stray PID.
#   2. reboot leg — the systemd unit is installed DISABLED and only `--commit` enables it, so an
#      uncommitted ruleset simply does not come back after a reboot. Kernel INPUT policy resets
#      to ACCEPT on boot, so an uncommitted board reboots into a reachable state.
#
# Deliberately NOT `set -e`: aborting mid-way could leave the rollback unarmed with the new
# ruleset live. Every step that matters is checked explicitly and says what it did instead — the
# previous version printed "installed" unconditionally and then ran whatever was already there.
set -uo pipefail

# How to re-invoke us. $0 alone is a bare filename under `bash install-firewall.sh`, which is
# precisely the invocation that broke the rollback — so never print or run $0 unqualified.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

[ "$(id -u)" = 0 ] || { echo "!! must run as root — try: sudo $SELF"; exit 1; }

SNAP4=/var/tmp/ledbox-fw-before.v4
SNAP6=/var/tmp/ledbox-fw-before.v6
SENTINEL=/var/tmp/ledbox-fw-commit
TARGET=/usr/local/sbin/ledbox-lan-guard.sh
UNIT=ledbox-lan-guard.service
ROLLBACK=ledbox-fw-rollback
GRACE=240

# Default to the checkout we were run from. The old hardcoded /tmp/ledbox-firewall.sh was
# world-writable, was never populated by anything in this repo, and was not what README told you
# to run — so the documented invocation installed nothing, said "installed", and then re-ran the
# OLD ruleset from a previous deploy.
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${SRC:-$HERE/ledbox-firewall.sh}
UNIT_SRC=${UNIT_SRC:-$HERE/$UNIT}

# A FUNCTION, not a re-exec of "$0". Run as `bash install-firewall.sh` — the natural fallback when
# the checkout arrived without the exec bit — $0 is a bare filename with no path, so the apply
# path's `"$0" --rollback-now` died with "install-firewall.sh: command not found" straight after
# printing "rolling back now". The operator reads that plus a non-zero exit as "the board was
# restored" and nothing had been. Same reason the timer's restore is inlined below.
rollback() {
  # Disable the unit too: rolling back and then rebooting must not quietly re-apply the very
  # ruleset that just cut us off.
  systemctl disable "$UNIT" >/dev/null 2>&1
  /usr/sbin/iptables-restore  < "$SNAP4" || { echo "!! v4 restore FAILED — rules NOT rolled back"; return 1; }
  /usr/sbin/ip6tables-restore < "$SNAP6" || { echo "!! v6 restore FAILED — rules NOT rolled back"; return 1; }
  echo "  rolled back to the snapshot"
  return 0
}

case "${1:-apply}" in
  --commit)
    touch "$SENTINEL"
    # Cancel the timer outright rather than trusting the sentinel alone — a transient unit left
    # ticking is one confusing reboot away from a support call.
    systemctl stop "${ROLLBACK}.timer" "${ROLLBACK}.service" >/dev/null 2>&1
    echo "  committed — auto-rollback disarmed"
    # Enabling the unit IS the commit. A hand-added iptables rule is precisely what silently
    # vanished on a reboot once and took the board's clock with it, and the old `--commit` only
    # *reported* `systemctl is-enabled` before an unconditional `exit 0` — so a board where the
    # unit did not exist at all printed "committed" and reverted at the next boot.
    if systemctl enable "$UNIT" >/dev/null 2>&1; then
      echo "  $UNIT enabled — the ruleset is reapplied at every boot"
      exit 0
    fi
    echo "  !! could not enable $UNIT — the firewall is NOT persistent across a reboot"
    echo "     run the apply step first so the unit gets installed, then commit again"
    exit 1 ;;

  --rollback-now)
    rollback
    exit $? ;;
esac

[ -r "$SRC" ]      || { echo "!! no firewall script at $SRC"; exit 1; }
[ -r "$UNIT_SRC" ] || { echo "!! no unit at $UNIT_SRC — without it the firewall dies at the next reboot"; exit 1; }

rm -f "$SENTINEL"
/usr/sbin/iptables-save  > "$SNAP4" || { echo "!! could not snapshot v4 rules — refusing to apply"; exit 1; }
/usr/sbin/ip6tables-save > "$SNAP6" || { echo "!! could not snapshot v6 rules — refusing to apply"; exit 1; }
# An empty or truncated snapshot is worse than no snapshot: the rollback would "succeed" and
# restore nothing at all. iptables-save always terminates each table with COMMIT.
grep -q '^COMMIT' "$SNAP4" || { echo "!! v4 snapshot looks empty — refusing to apply"; exit 1; }
grep -q '^COMMIT' "$SNAP6" || { echo "!! v6 snapshot looks empty — refusing to apply"; exit 1; }
echo "  snapshot saved ($(grep -c . "$SNAP4") v4 lines, $(grep -c . "$SNAP6") v6 lines)"

install -o root -g root -m 0755 "$SRC" "$TARGET" \
  || { echo "!! could not install $TARGET — nothing applied"; exit 1; }
echo "  installed $TARGET (from $SRC)"

install -o root -g root -m 0644 "$UNIT_SRC" "/etc/systemd/system/$UNIT" \
  || { echo "!! could not install /etc/systemd/system/$UNIT"; exit 1; }
systemctl daemon-reload || { echo "!! daemon-reload failed"; exit 1; }
echo "  installed /etc/systemd/system/$UNIT"

systemctl stop "${ROLLBACK}.timer" "${ROLLBACK}.service" >/dev/null 2>&1
# The restore is inlined rather than re-invoking this script, so the rollback does not depend on
# the checkout still being on the board when it fires.
if ! systemd-run --unit="$ROLLBACK" --on-active="$GRACE" \
     --description="LedBox firewall auto-rollback (fires unless --commit ran)" \
     /bin/bash -c "[ -f '$SENTINEL' ] && exit 0
       /usr/sbin/iptables-restore  < '$SNAP4'
       /usr/sbin/ip6tables-restore < '$SNAP6'
       systemctl disable '$UNIT'
       logger -t ledbox-fw 'AUTO-ROLLBACK fired: new firewall was never committed'" >/dev/null 2>&1; then
  echo "!! could not arm the auto-rollback — refusing to apply a default-deny policy without one"
  exit 1
fi
echo "  auto-rollback armed: ${GRACE}s unless committed (transient unit ${ROLLBACK}.timer)"

# Left DISABLED on purpose — see the reboot leg at the top. --commit enables it. Deliberately
# AFTER the arming, not before: the arming can fail, and that path exits without touching
# netfilter at all — but it used to leave an already-committed board's boot unit disabled anyway,
# so the next reboot came up unfirewalled and nothing anywhere said so.
systemctl disable "$UNIT" >/dev/null 2>&1
echo "  $UNIT left disabled until --commit"

if ! "$TARGET"; then
  echo "!! the ruleset did not apply cleanly (see above) — rolling back now rather than waiting"
  rollback
  exit 1
fi
echo "  applied — verify from another machine, then: sudo $SELF --commit"
