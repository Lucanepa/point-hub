#!/bin/bash
# Install the default-deny firewall WITH AN AUTO-ROLLBACK.
#
#   sudo bash ledbox-bridge/provisioning/install-firewall.sh --check         # read-only: what is live, what is staged
#   sudo bash ledbox-bridge/provisioning/install-firewall.sh                 # apply, auto-rollback in 240 s
#   sudo bash ledbox-bridge/provisioning/install-firewall.sh --commit        # keep it (and at every boot)
#   sudo bash ledbox-bridge/provisioning/install-firewall.sh --rollback-now  # undo at once
#
# A default-deny INPUT policy applied over SSH is the classic way to lock yourself out of a
# device. So: snapshot the current rules, arm a timer that restores them in 240 s, then apply.
# If the new rules cut our own access, the timer undoes them and the board comes back on its
# own. If verification passes, `--commit` disarms the timer and makes the rules permanent.
#
# STAGED, NOT INSTALLED, UNTIL --commit. The new ruleset is copied to ledbox-lan-guard.sh.new and
# run from there; the boot unit keeps running the COMMITTED /usr/local/sbin/ledbox-lan-guard.sh and
# keeps whatever enabled state it had. Until 21.11.2026 the apply overwrote the committed script and
# DISABLED the boot unit straight away, so on a board that already had a committed firewall:
#   - a reboot inside the grace window (or a power cut) came up with NO firewall at all — no INPUT
#     drop, no forward drop, the board's Wi-Fi no longer "control only";
#   - a rollback that fired restored the old rules but left the unit disabled and the NEW script
#     installed — the board was unfirewalled from its next boot on, and nothing said so.
# Now an uncommitted board reboots into exactly what it had before the apply (its committed
# firewall, or none on a first install), and a rollback leaves nothing behind but the old rules.
#
# The rollback has TWO independent legs:
#   1. session leg — a transient systemd timer, which survives the SSH session ending and is
#      visible and cancellable (`systemctl list-timers ledbox-fw-rollback.timer`).
#   2. reboot leg — the committed script and the unit's enabled state are untouched until
#      --commit, so a reboot simply runs what was committed before.
#
# The apply ignores SIGHUP: run over SSH through the tailnet, a session that drops while the
# ruleset is being rebuilt used to be able to kill the script half way — LEDBOX-IN flushed under an
# INPUT policy of DROP, i.e. no ESTABLISHED accept, so the replies of tailscale's DERP connection
# (TCP 443 out of wlan1) were dropped and the tailnet went with them until the timer fired. Every
# step is also written to /var/tmp/ledbox-fw-install.log and synced to disk, with the journal, as it
# happens: on 18.11.2026 the C0270's journal ended before the first line of this script, and there
# was no way to tell afterwards how far it had got.
#
# Deliberately NOT `set -e`: aborting mid-way could leave the rollback unarmed with the new
# ruleset live. Every step that matters is checked explicitly and says what it did instead.
set -uo pipefail
trap '' HUP PIPE

# How to re-invoke us. $0 alone is a bare filename under `bash install-firewall.sh`, which is
# precisely the invocation that broke the rollback once — so never print or run $0 unqualified.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
HERE=$(cd "$(dirname "$0")" && pwd)

# Paths and commands can be moved for the tests (test/firewall-install-netns.sh); on a board none
# of these are set.
STATE_DIR=${LEDBOX_FW_STATE_DIR:-/var/tmp}
TARGET=${LEDBOX_FW_TARGET:-/usr/local/sbin/ledbox-lan-guard.sh}
UNIT_DIR=${LEDBOX_FW_UNIT_DIR:-/etc/systemd/system}
SBIN=${LEDBOX_FW_SBIN:-/usr/sbin}
GRACE=${LEDBOX_FW_GRACE:-240}
APPLY_TIMEOUT=${LEDBOX_FW_APPLY_TIMEOUT:-120}
SYSTEMCTL=${SYSTEMCTL:-systemctl}
SYSTEMD_RUN=${SYSTEMD_RUN:-systemd-run}
LOGGER=${LOGGER:-logger}
JOURNALCTL=${JOURNALCTL:-journalctl}
TAILSCALE=${TAILSCALE:-tailscale}

SNAP4=$STATE_DIR/ledbox-fw-before.v4
SNAP6=$STATE_DIR/ledbox-fw-before.v6
SENTINEL=$STATE_DIR/ledbox-fw-commit
LOG=$STATE_DIR/ledbox-fw-install.log
STAGED=$TARGET.new
RB_FILE=$STATE_DIR/ledbox-fw-rollback.sh
UNIT=ledbox-lan-guard.service
ROLLBACK=ledbox-fw-rollback

# Default to the checkout we were run from (deploy-board.sh ships provisioning/ next to this).
SRC=${SRC:-$HERE/ledbox-firewall.sh}
UNIT_SRC=${UNIT_SRC:-$HERE/$UNIT}

MODE=${1:-apply}
case "$MODE" in apply|--apply|--check|--commit|--rollback-now) ;;
  *) sed -n '2,8p' "$SELF"; exit 2 ;; esac
[ "$(id -u)" = 0 ] || { echo "!! must run as root — try: sudo bash $SELF $MODE"; exit 1; }

# One line to the terminal, the step log and the journal; persist() then puts both on the card.
step() {
  echo "  $*"
  { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; } 2>/dev/null
  $LOGGER -t ledbox-fw -- "$*" 2>/dev/null || true
}
persist() {
  sync "$LOG" 2>/dev/null || sync 2>/dev/null
  timeout 5 $JOURNALCTL --sync >/dev/null 2>&1 || true
}

# The restore, in ONE place: the timer runs exactly this text, from its own file next to the
# snapshots (so it does not depend on the checkout still being on the board when it fires, and
# systemd never sees a `$` to expand — on systemd 252 it substitutes `$VAR` in a transient unit's
# command line), and --rollback-now / a failed apply run it directly. $1 = "timer" makes it a
# no-op once --commit has run. If a restore fails, the INPUT policy is forced open rather than left
# at DROP over whatever half-state is there: an unfirewalled board is recoverable, a locked-out one
# is not.
ROLLBACK_SH="
[ \"\${1:-}\" = timer ] && [ -f '$SENTINEL' ] && exit 0
ok=1
$SBIN/iptables-restore -w 5 < '$SNAP4' || ok=0
$SBIN/ip6tables-restore -w 5 < '$SNAP6' || ok=0
if [ \$ok = 0 ]; then
  $SBIN/iptables -w 5 -P INPUT ACCEPT; $SBIN/ip6tables -w 5 -P INPUT ACCEPT
  msg='restore FAILED - INPUT policy forced to ACCEPT (board unfirewalled until the next boot)'
else
  msg='restored the rules from before the apply'
fi
rm -f '$STAGED'
echo \"  rollback: \$msg\"
echo \"\$(date '+%F %T') rollback (\${1:-now}): \$msg\" >> '$LOG' 2>/dev/null
$LOGGER -t ledbox-fw -- \"AUTO-ROLLBACK (\${1:-now}): \$msg\" 2>/dev/null
sync '$LOG' 2>/dev/null || sync
[ \$ok = 1 ]
"
rollback() { /bin/bash -c "$ROLLBACK_SH" ledbox-fw-rollback now; }

# A time bound that keeps SIGHUP ignored in the command: timeout(1) installs its own HUP handler,
# and the command it execs then gets HUP's default action back — exactly what must not happen to
# the ruleset rebuild when the SSH session drops.
run_bounded() { # $1 = seconds, then the command
  local secs=$1 pid w rc; shift
  "$@" & pid=$!
  ( sleep "$secs"; kill -TERM "$pid" ) >/dev/null 2>&1 & w=$!
  wait "$pid"; rc=$?
  kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return $rc
}

timer_active() { $SYSTEMCTL is-active --quiet "${ROLLBACK}.timer" 2>/dev/null; }
disarm() { $SYSTEMCTL stop "${ROLLBACK}.timer" "${ROLLBACK}.service" >/dev/null 2>&1; $SYSTEMCTL reset-failed "${ROLLBACK}.timer" "${ROLLBACK}.service" >/dev/null 2>&1; }

# The ruleset that must be there after an apply for the board to stay reachable: the hook, the
# ESTABLISHED accept (tailscale's DERP replies, every SSH session), tailscale's interface and direct
# port, the console on the AP, SSH on the cable — and tailscale's own chains still hooked in, when
# they were before. ledbox-firewall.sh never touches INPUT beyond appending its hook, so a miss here
# is something it did not expect (a vendor rule, an iptables-legacy/nft mix): roll back at once.
verify_rules() {
  local fam B snap s bad=0 need
  for fam in 4 6; do
    B="$SBIN/iptables"; snap=$SNAP4
    [ "$fam" = 6 ] && B="$SBIN/ip6tables" && snap=$SNAP6
    s=$($B -w 5 -S 2>/dev/null)
    for need in \
      '-A INPUT -j LEDBOX-IN' \
      '-A LEDBOX-IN -i lo -j ACCEPT' \
      '-A LEDBOX-IN -m conntrack --ctstate (RELATED,ESTABLISHED|ESTABLISHED,RELATED) -j ACCEPT' \
      '-A LEDBOX-IN -i tailscale0 -j ACCEPT' \
      '-A LEDBOX-IN -i wlan1 -p udp -m udp --dport 41641 -j ACCEPT' \
      '-A LEDBOX-IN -i wlan0 -p tcp -m tcp --dport 8890 -j ACCEPT' \
      '-A LEDBOX-IN -i eth0 -p tcp -m tcp --dport 22 -j ACCEPT'; do
      grep -Eqx -- "$need" <<<"$s" || { echo "  !! v$fam: missing  $need"; bad=1; }
    done
    for need in '-A INPUT -j ts-input' '-A FORWARD -j ts-forward'; do
      if grep -qx -- "$need" "$snap" 2>/dev/null && ! grep -qx -- "$need" <<<"$s"; then
        echo "  !! v$fam: tailscale's hook is gone: $need"; bad=1
      fi
    done
  done
  [ "$bad" = 0 ]
}

ts_line() {
  command -v "$TAILSCALE" >/dev/null 2>&1 || { echo "tailscale not installed"; return; }
  local j
  j=$(timeout 5 "$TAILSCALE" status --self --peers=false --json 2>/dev/null) || { echo "tailscale status did not answer"; return; }
  echo "backend $(grep -m1 -o '"BackendState": *"[^"]*"' <<<"$j" | sed 's/.*: *//; s/"//g'), online $(grep -m1 -o '"Online": *[a-z]*' <<<"$j" | sed 's/.*: *//'), relay $(grep -m1 -o '"Relay": *"[^"]*"' <<<"$j" | sed 's/.*: *//; s/"//g')"
}

case "$MODE" in
  --check)
    say() { echo "== $*"; }
    say "install-firewall --check (read-only)"
    if [ -e "$TARGET" ]; then
      echo "  committed script: $TARGET ($(date -r "$TARGET" '+%F %T'))"
      if [ -r "$SRC" ] && cmp -s "$TARGET" "$SRC"; then echo "    same as this checkout's $(basename "$SRC")"
      else echo "    differs from this checkout's $(basename "$SRC") — an apply + --commit installs that"; fi
      grep -q OV_ONLINE_HELPER "$TARGET" && echo "    knows OpenVolley online" || echo "    predates OpenVolley online"
    else
      echo "  committed script: none ($TARGET missing — first install)"
    fi
    [ -e "$STAGED" ] && echo "  !! staged, NOT committed: $STAGED ($(date -r "$STAGED" '+%F %T')) — --commit or --rollback-now"
    echo "  boot unit $UNIT: $($SYSTEMCTL is-enabled "$UNIT" 2>/dev/null || echo 'not installed'), $($SYSTEMCTL is-active "$UNIT" 2>/dev/null)"
    timer_active && echo "  !! auto-rollback ARMED: $($SYSTEMCTL list-timers --all --no-legend "${ROLLBACK}.timer" 2>/dev/null | head -1)" \
      || echo "  auto-rollback: not armed"
    for f in "$SNAP4" "$SNAP6" "$SENTINEL"; do [ -e "$f" ] && echo "  $f: $(date -r "$f" '+%F %T')"; done
    for fam in 4 6; do
      B="$SBIN/iptables"; [ "$fam" = 6 ] && B="$SBIN/ip6tables"
      s=$($B -w 5 -S 2>/dev/null)
      echo "  v$fam: $(grep -m1 '^-P INPUT' <<<"$s" | sed 's/^-P //'), $(grep -m1 '^-P FORWARD' <<<"$s" | sed 's/^-P //'), $(grep -m1 '^-P OUTPUT' <<<"$s" | sed 's/^-P //')"
      echo "      INPUT:   $(grep '^-A INPUT ' <<<"$s" | sed 's/^-A INPUT //' | paste -sd'|' | sed 's/|/  |  /g')"
      echo "      FORWARD: $(grep '^-A FORWARD ' <<<"$s" | sed 's/^-A FORWARD //' | paste -sd'|' | sed 's/|/  |  /g')"
      echo "      LEDBOX-IN rules: $(grep -c '^-A LEDBOX-IN ' <<<"$s"), ts-input rules: $(grep -c '^-A ts-input ' <<<"$s")"
    done
    echo "  iptables: $($SBIN/iptables -V 2>/dev/null)"
    if command -v iptables-legacy >/dev/null 2>&1; then
      n=$(iptables-legacy -S 2>/dev/null | grep -c '^-A' || true)
      [ "${n:-0}" = 0 ] && echo "  iptables-legacy: no rules (no nft/legacy mix)" || echo "  !! iptables-legacy has $n rule(s) next to the nft ones — a mix: $(iptables-legacy -S 2>/dev/null | grep '^-A' | head -3 | paste -sd';')"
    fi
    echo "  tailscale: $(ts_line)"
    echo "  kernel forwarding: v4=$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null) v6=$(cat /proc/sys/net/ipv6/conf/all/forwarding 2>/dev/null); rp_filter all=$(cat /proc/sys/net/ipv4/conf/all/rp_filter 2>/dev/null) wlan1=$(cat /proc/sys/net/ipv4/conf/wlan1/rp_filter 2>/dev/null)"
    if [ -r "$LOG" ]; then echo "  last lines of $LOG:"; tail -n 12 "$LOG" | sed 's/^/    /'; fi
    exit 0 ;;

  --commit)
    if [ ! -e "$STAGED" ]; then
      if timer_active; then
        # An apply by the previous version of this script (it installed in place): keep it.
        touch "$SENTINEL"; disarm
        step "commit: auto-rollback disarmed (an apply of the earlier installer)"
        if $SYSTEMCTL enable "$UNIT" >/dev/null 2>&1; then step "commit: $UNIT enabled"; persist; exit 0; fi
        echo "  !! could not enable $UNIT — the firewall is NOT persistent across a reboot"; persist; exit 1
      fi
      echo "  !! nothing to commit: no staged ruleset ($STAGED) and no rollback armed."
      echo "     Either the auto-rollback already fired (the board runs the rules from before the apply),"
      echo "     or no apply ran. Check: sudo bash $SELF --check"
      exit 1
    fi
    # Disarm FIRST, so the timer cannot fire half way through the commit.
    touch "$SENTINEL"; disarm
    step "commit: auto-rollback disarmed"
    if ! install -o root -g root -m 0755 "$STAGED" "$TARGET.tmp" || ! mv -f "$TARGET.tmp" "$TARGET"; then
      rm -f "$TARGET.tmp"
      step "!! commit: could not install $TARGET — the live rules stay, but a reboot runs the old script"
      persist; exit 1
    fi
    rm -f "$STAGED"
    step "commit: installed $TARGET"
    # Enabling the unit IS the commit: a hand-added iptables rule is precisely what silently vanished
    # on a reboot once and took the board's clock with it.
    if $SYSTEMCTL enable "$UNIT" >/dev/null 2>&1; then
      step "commit: $UNIT enabled — the ruleset is reapplied at every boot"
      persist; exit 0
    fi
    step "!! commit: could not enable $UNIT — the firewall is NOT persistent across a reboot"
    persist; exit 1 ;;

  --rollback-now)
    disarm
    [ -r "$SNAP4" ] && [ -r "$SNAP6" ] || { echo "!! no snapshot in $STATE_DIR — nothing to roll back to"; exit 1; }
    rollback
    rc=$?; persist; exit $rc ;;
esac

# ── apply ──────────────────────────────────────────────────────────────────────────────────────────
[ -r "$SRC" ]      || { echo "!! no firewall script at $SRC"; exit 1; }
[ -r "$UNIT_SRC" ] || { echo "!! no unit at $UNIT_SRC — without it the firewall dies at the next reboot"; exit 1; }
bash -n "$SRC" 2>/dev/null || { echo "!! $SRC does not parse (a truncated copy?) — nothing applied"; exit 1; }
mkdir -p "$STATE_DIR"

echo "  The SSH session may stall for a moment while the rules are rebuilt; this keeps going if it drops."
echo "  Lost access? Wait ${GRACE} s: the auto-rollback restores the rules from before."
step "apply: start (from $SRC; committed script $( [ -e "$TARGET" ] && date -r "$TARGET" '+%F %T' || echo none), unit $($SYSTEMCTL is-enabled "$UNIT" 2>/dev/null || echo 'not installed'))"
persist

rm -f "$SENTINEL"
$SBIN/iptables-save  > "$SNAP4" || { step "!! could not snapshot v4 rules — refusing to apply"; exit 1; }
$SBIN/ip6tables-save > "$SNAP6" || { step "!! could not snapshot v6 rules — refusing to apply"; exit 1; }
# An empty or truncated snapshot is worse than no snapshot: the rollback would "succeed" and
# restore nothing at all. iptables-save always terminates each table with COMMIT.
grep -q '^COMMIT' "$SNAP4" || { step "!! v4 snapshot looks empty — refusing to apply"; exit 1; }
grep -q '^COMMIT' "$SNAP6" || { step "!! v6 snapshot looks empty — refusing to apply"; exit 1; }
sync "$SNAP4" "$SNAP6" 2>/dev/null || sync
step "apply: snapshot saved ($(grep -c . "$SNAP4") v4 lines, $(grep -c . "$SNAP6") v6 lines, ts-input hooked: $(grep -qx -- '-A INPUT -j ts-input' "$SNAP4" && echo yes || echo no))"

install -o root -g root -m 0755 "$SRC" "$STAGED" \
  || { step "!! could not stage $STAGED — nothing applied"; exit 1; }
step "apply: staged $STAGED (the committed $TARGET and the boot unit are untouched until --commit)"

# The unit file, only when it differs: a daemon-reload is not free, and it is a call into PID 1 that
# can hang on a board whose SD card is struggling — bounded here either way.
if ! cmp -s "$UNIT_SRC" "$UNIT_DIR/$UNIT"; then
  install -o root -g root -m 0644 "$UNIT_SRC" "$UNIT_DIR/$UNIT" \
    || { step "!! could not install $UNIT_DIR/$UNIT — nothing applied"; rm -f "$STAGED"; exit 1; }
  timeout 60 $SYSTEMCTL daemon-reload || { step "!! daemon-reload failed or hung — nothing applied"; rm -f "$STAGED"; exit 1; }
  step "apply: installed $UNIT_DIR/$UNIT (left $($SYSTEMCTL is-enabled "$UNIT" 2>/dev/null || echo disabled))"
fi

# A transient unit from an earlier run that FAILED stays loaded and makes systemd-run refuse the
# name: clear it first.
disarm
rm -f "$RB_FILE"
if ! { printf '#!/bin/bash\n# install-firewall.sh: the auto-rollback (fires unless --commit ran)\n%s' "$ROLLBACK_SH" > "$RB_FILE" \
       && chmod 0700 "$RB_FILE" && { sync "$RB_FILE" 2>/dev/null || sync; }; } \
   || ! timeout 30 $SYSTEMD_RUN --unit="$ROLLBACK" --on-active="$GRACE" \
     --description="LedBox firewall auto-rollback (fires unless --commit ran)" \
     /bin/bash "$RB_FILE" timer >/dev/null 2>&1; then
  disarm
  rm -f "$STAGED"
  step "!! could not arm the auto-rollback — refusing to apply a default-deny policy without one"
  persist; exit 1
fi
step "apply: auto-rollback armed: ${GRACE}s unless committed (transient unit ${ROLLBACK}.timer)"
persist

if ! run_bounded "$APPLY_TIMEOUT" "$STAGED"; then
  step "!! the ruleset did not apply cleanly (see above) — rolling back now rather than waiting"
  disarm; rollback; persist
  exit 1
fi
if ! verify_rules; then
  step "!! the live rules are missing something the board needs (above) — rolling back now"
  disarm; rollback; persist
  exit 1
fi
step "apply: applied and checked (LEDBOX-IN, ESTABLISHED, tailscale0, udp/41641, AP console, cable SSH; tailscale hooks kept)"
persist
echo "  tailscale: $(ts_line)"
echo
echo "  NOT committed. Within ${GRACE} s, from ANOTHER machine: ssh over the tailnet, the console on the"
echo "  board's Wi-Fi and on the cable. Then:  sudo bash $SELF --commit"
echo "  Undo at once:                         sudo bash $SELF --rollback-now"
