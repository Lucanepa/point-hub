#!/bin/bash
# Self-healing on the LedBox board: who restarts what, and what survives a crash to tell the tale.
#
# What already exists, and is NOT duplicated here:
#   - firmware/ledbox-watchdog.sh (on the board: /home/pi/ledbox/bin/watchdog, unit ledbox-watchdog)
#     keeps the vendor app running, keeps flushBuffer2 running, and restarts the app when buffer.png
#     stops changing (a dead render thread behind a live :8889). Its checks are process-level.
#   - ledbox-bridge.service has Restart=always: a bridge that EXITS comes back in 5 s.
#
# What nothing covers today, one step each (all opt-in, all idempotent):
#   watchdog  ledbox-watchdog has been DISABLED since 2026-07-31 (firmware/RECOVERY.md "OPEN") — the
#             board has had no crash recovery at all. Re-enable it, with Restart=always on its own
#             unit (if the bash loop itself dies, nothing restarts it), after making sure the board
#             runs the repo's script: an older copy steps the wall clock into "hours stale" at the
#             first NTP sync and kills a healthy app mid-match (REVIEW-2026-08-04, now uptime-based).
#   restart   hostapd and dnsmasq carry no Restart= on Debian. A crashed hostapd is a board with no
#             AP — the tablet loses the console — until someone power-cycles it. on-failure, 5 s.
#   probe     a bridge that is ALIVE but wedged (a stuck event loop) never exits, so Restart=always
#             never fires. ledbox-bridge-probe asks GET 127.0.0.1:8890/api/status every 30 s and
#             restarts the bridge after 3 misses in a row (90 s of silence). Not sd_notify: Node has
#             no AF_UNIX datagram socket and a short-lived systemd-notify races on systemd 252.
#   hwdog     the Pi's hardware watchdog through systemd: RuntimeWatchdogSec=14s (bcm2835_wdt tops
#             out just under 16 s), RebootWatchdogSec=2min, and kernel.panic=10. A kernel or I/O hang
#             — a 2019 SD card stalling — freezes the panel with every process "running"; nothing
#             above can see it. Now the board resets itself.
#   crashlog  a crash log that survives the reset: a persistent, capped journal (64 MB, synced every
#             minute) so `journalctl -b -1` shows the run up to the hang, and ramoops (config.txt
#             dtoverlay=ramoops) so a panic's last kernel words land in /var/lib/systemd/pstore.
#
# NOT run by deploy-board.sh. On the board, from the bridge install:
#
#   sudo bash ledbox-bridge/provisioning/setup-supervision.sh                 # --check: read-only
#   sudo bash ledbox-bridge/provisioning/setup-supervision.sh --apply watchdog
#   sudo bash ledbox-bridge/provisioning/setup-supervision.sh --apply hwdog   # one step per run...
#   sudo bash ledbox-bridge/provisioning/setup-supervision.sh --rollback      # ...undoes the last run
#
# --apply with no step names applies all five in one run (and one --rollback then undoes all five).
# Every changed file is backed up first (provisioning/lib-provision.sh); a step that cannot back up
# its file does not touch it, and a step whose files are already right writes nothing. `crashlog`
# takes effect fully only after a reboot (config.txt); everything else is live at once.
set -uo pipefail

LP_NAME=setup-supervision
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
. "$HERE/lib-provision.sh" || { echo "!! lib-provision.sh missing next to $0"; exit 1; }

ALL="watchdog restart probe hwdog crashlog"
MODE=${1:---check}
shift || true
STEPS=${*:-$ALL}
for s in $STEPS; do case " $ALL " in *" $s "*) ;; *) echo "!! unknown step '$s' (steps: $ALL)"; exit 2 ;; esac; done
case "$MODE" in --check|--apply|--rollback) ;; *) sed -n '2,46p' "$0"; exit 2 ;; esac
lp_need_root "$MODE"

RC=0
fail() { echo "  !! $*"; RC=1; }

# ── watchdog ────────────────────────────────────────────────────────────────────────────────────
WD_UNIT=ledbox-watchdog
WD_SRC=${WD_SRC:-$HERE/../firmware/ledbox-watchdog.sh}   # in a checkout, and where deploy ships it
WD_DEFAULT=/home/pi/ledbox/bin/watchdog
PANEL_LOCK=/home/pi/ledbox/panel.lock

wd_exists() { systemctl cat "$WD_UNIT" >/dev/null 2>&1; }
# The script the unit runs: argv[0], or argv[1] when argv[0] is a shell.
wd_script() {
  local argv; argv=$(systemctl show -p ExecStart --value "$WD_UNIT" 2>/dev/null | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p')
  set -- $argv
  case "${1:-}" in */bash|*/sh|bash|sh) echo "${2:-}" ;; *) echo "${1:-}" ;; esac
}
wd_wants() {
  local t; t=$(systemctl cat "$WD_UNIT" 2>/dev/null | sed -n 's/^WantedBy=//p' | awk '{print $1}' | head -1)
  echo "/etc/systemd/system/${t:-multi-user.target}.wants/$WD_UNIT.service"
}

check_watchdog() {
  say "watchdog — ledbox-watchdog (app + panel driver + frozen-frame check)"
  if ! wd_exists; then echo "  unit $WD_UNIT: NOT INSTALLED (--apply watchdog creates it)"; return; fi
  echo "  enabled: $(systemctl is-enabled "$WD_UNIT" 2>/dev/null)   active: $(systemctl is-active "$WD_UNIT" 2>/dev/null)   Restart=$(systemctl show -p Restart --value "$WD_UNIT")"
  local s; s=$(wd_script)
  echo "  runs: ${s:-?}"
  if [ -f "$s" ] && [ -f "$WD_SRC" ]; then
    if cmp -s "$s" "$WD_SRC"; then echo "  same as the repo's firmware/ledbox-watchdog.sh"
    else
      echo "  !! DIFFERS from the repo's firmware/ledbox-watchdog.sh — --apply installs the repo's (old one backed up)"
      grep -q uptime_s "$s"    || echo "     the board's copy has no uptime-based staleness: an NTP step makes it kill a healthy app"
      grep -q systemd-run "$s" || echo "     the board's copy starts the panel inside its own cgroup: restarting it darkens the panel"
    fi
  elif [ ! -f "$WD_SRC" ]; then
    echo "  (no repo copy at $WD_SRC to compare against — deploy-board.sh ships it)"
  fi
  journalctl -t ledbox-watchdog -n 3 --no-pager 2>/dev/null | sed 's/^/  log: /'
}

apply_watchdog() {
  say "watchdog — enable ledbox-watchdog"
  local s rc
  if ! wd_exists; then
    [ -f "$WD_DEFAULT" ] || [ -f "$WD_SRC" ] || { fail "no unit, no $WD_DEFAULT and no $WD_SRC — nothing to enable"; return; }
    lp_put /etc/systemd/system/$WD_UNIT.service 0644 <<EOF
# Written by point-hub provisioning/setup-supervision.sh (the board had no ledbox-watchdog unit).
# Runs as root: it pkills the app and launches the panel driver through systemd-run.
[Unit]
Description=KSCW LedBox watchdog (keeps the scoreboard app and the LED panel driver running)
After=rc-local.service

[Service]
Type=simple
ExecStart=$WD_DEFAULT
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
    [ $? = 1 ] && { fail "could not create the unit"; return; }
    systemctl daemon-reload
  fi
  s=$(wd_script)
  [ -n "$s" ] || { fail "cannot tell which script $WD_UNIT runs"; return; }
  if [ -f "$WD_SRC" ] && ! cmp -s "$s" "$WD_SRC" 2>/dev/null; then
    if [ "${KEEP_BOARD_WATCHDOG:-0}" = 1 ]; then
      echo "  KEEP_BOARD_WATCHDOG=1 — leaving the board's own $s in place"
    else
      local own=root:root
      [ -f "$s" ] && own="$(stat -c %U:%G "$s")"
      lp_bak "$s" || { fail "backup of $s failed — not replacing it"; return; }
      install -D -o "${own%:*}" -g "${own#*:}" -m 0755 "$WD_SRC" "$s" \
        && echo "  installed the repo's watchdog at $s" || { fail "could not install $s"; return; }
    fi
  fi
  if [ "$(systemctl show -p Restart --value "$WD_UNIT")" = no ]; then
    lp_put /etc/systemd/system/$WD_UNIT.service.d/ledbox-restart.conf 0644 <<'EOF'
# point-hub provisioning/setup-supervision.sh: if the watchdog loop itself dies, start it again.
[Unit]
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=10
EOF
    rc=$?; [ "$rc" = 1 ] && { fail "could not add Restart="; return; }
    systemctl daemon-reload
  fi
  # Back up the enable symlink as a path: absent before means a rollback disables it again.
  lp_bak "$(wd_wants)" || { fail "backup failed"; return; }
  systemctl enable "$WD_UNIT" >/dev/null 2>&1 || { fail "could not enable $WD_UNIT"; return; }
  # restart, not --now: a running copy keeps the OLD script until it is restarted. An old copy that
  # launched the driver in its own cgroup takes the panel down with it — so put the panel back.
  systemctl restart "$WD_UNIT" || { fail "could not start $WD_UNIT"; return; }
  sleep 2
  if ! pgrep -x flushBuffer2 >/dev/null && [ ! -f /home/pi/ledbox/PANEL_OFF ]; then
    echo "  the panel driver went down with the old watchdog — starting it again"
    flock -o -w 20 "$PANEL_LOCK" systemd-run --quiet --collect --unit="ledbox-panel-setup-$$" /home/pi/ledbox/bin/startled \
      || fail "could not restart the panel driver: sudo systemd-run --collect /home/pi/ledbox/bin/startled"
  fi
  echo "  $WD_UNIT: $(systemctl is-enabled "$WD_UNIT") / $(systemctl is-active "$WD_UNIT") — it waits 90 s, then logs 'watchdog started'"
}

# ── restart ─────────────────────────────────────────────────────────────────────────────────────
RESTART_UNITS="hostapd dnsmasq"
check_restart() {
  say "restart — Restart= policies"
  local u
  for u in ledbox-bridge $RESTART_UNITS tailscaled NetworkManager; do
    systemctl cat "$u" >/dev/null 2>&1 || { echo "  $u: not installed"; continue; }
    printf '  %-15s Restart=%-12s active=%s\n' "$u" "$(systemctl show -p Restart --value "$u")" "$(systemctl is-active "$u")"
  done
}
apply_restart() {
  say "restart — Restart=on-failure for $RESTART_UNITS"
  local u d
  for u in $RESTART_UNITS; do
    systemctl cat "$u" >/dev/null 2>&1 || { echo "  $u: not installed, skipped"; continue; }
    d=/etc/systemd/system/$u.service.d/ledbox-restart.conf
    if [ ! -f "$d" ] && [ "$(systemctl show -p Restart --value "$u")" != no ]; then
      echo "  $u: already Restart=$(systemctl show -p Restart --value "$u")"; continue
    fi
    # A bounded burst, unlike the watchdog: a hostapd that dies on a bad config would otherwise loop
    # forever every 5 s. Ten tries in five minutes covers a crash; a broken config shows as failed.
    lp_put "$d" 0644 <<EOF
# point-hub provisioning/setup-supervision.sh: a crashed $u comes back by itself.
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Restart=on-failure
RestartSec=5
EOF
    [ $? = 1 ] && fail "could not write $d"
  done
  systemctl daemon-reload || fail "daemon-reload failed"
  for u in $RESTART_UNITS; do
    systemctl cat "$u" >/dev/null 2>&1 && echo "  $u: Restart=$(systemctl show -p Restart --value "$u")"
  done
}

# ── probe ───────────────────────────────────────────────────────────────────────────────────────
PROBE_BIN=/usr/local/sbin/ledbox-bridge-probe
PROBE_UNIT=/etc/systemd/system/ledbox-bridge-probe.service
PROBE_WANTS=/etc/systemd/system/multi-user.target.wants/ledbox-bridge-probe.service
check_probe() {
  say "probe — bridge liveness (GET :8890/api/status)"
  if [ -f "$PROBE_UNIT" ]; then
    echo "  ledbox-bridge-probe: $(systemctl is-enabled ledbox-bridge-probe 2>/dev/null) / $(systemctl is-active ledbox-bridge-probe 2>/dev/null)"
    journalctl -t ledbox-bridge-probe -n 3 --no-pager 2>/dev/null | sed 's/^/  log: /'
  else
    echo "  not installed"
  fi
  echo -n "  :8890 answers now: "
  if curl -fsS -m 5 -o /dev/null http://127.0.0.1:8890/api/status 2>/dev/null; then echo yes; else echo "NO (or no curl)"; fi
}
apply_probe() {
  say "probe — install ledbox-bridge-probe"
  local a b
  lp_put "$PROBE_BIN" 0755 <<'EOF'
#!/bin/bash
# Installed by point-hub provisioning/setup-supervision.sh — the bridge liveness probe.
# ledbox-bridge has Restart=always, which only helps when it EXITS. This catches the other case:
# the service is active but GET /api/status has stopped answering (a wedged event loop). Three
# misses in a row, 30 s apart, then one restart. Quiet when healthy: it logs only misses.
URL=http://127.0.0.1:8890/api/status
LIMIT=3
ask() {
  if command -v curl >/dev/null; then curl -fsS -m 5 -o /dev/null "$URL" 2>/dev/null
  else /opt/nodejs/bin/node -e "fetch('$URL',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; fi
}
sleep 120   # let a cold boot finish; the bridge's own (re)starts get the grace below
miss=0
while :; do
  if ! systemctl is-active --quiet ledbox-bridge; then
    miss=0                                  # stopped or restarting: systemd's Restart= owns that
  else
    since=$(systemctl show -p ActiveEnterTimestampMonotonic --value ledbox-bridge)
    now=$(awk '{printf "%d", $1 * 1000000}' /proc/uptime)
    if [ -n "$since" ] && [ $(( (now - since) / 1000000 )) -lt 60 ]; then
      miss=0                                # just (re)started — give it a minute to bind :8890
    elif ask; then
      [ "$miss" -gt 0 ] && logger -t ledbox-bridge-probe "answering again after $miss miss(es)"
      miss=0
    else
      miss=$((miss + 1))
      logger -t ledbox-bridge-probe -p daemon.warning "ledbox-bridge is active but $URL gave no answer in 5 s ($miss/$LIMIT)"
      if [ "$miss" -ge "$LIMIT" ]; then
        logger -t ledbox-bridge-probe -p daemon.warning "restarting ledbox-bridge"
        systemctl restart ledbox-bridge
        miss=0
      fi
    fi
  fi
  sleep 30
done
EOF
  a=$?
  lp_put "$PROBE_UNIT" 0644 <<'EOF'
# Installed by point-hub provisioning/setup-supervision.sh. A loop, not a timer: a 30 s timer logs
# "Starting/Finished" three times a minute into a journal that lives on the SD card.
[Unit]
Description=LedBox: restart ledbox-bridge when it is running but no longer answers
After=ledbox-bridge.service

[Service]
Type=simple
ExecStart=/usr/local/sbin/ledbox-bridge-probe
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF
  b=$?
  { [ "$a" = 1 ] || [ "$b" = 1 ]; } && { fail "could not install the probe"; return; }
  lp_bak "$PROBE_WANTS" || { fail "backup failed"; return; }
  systemctl daemon-reload
  systemctl enable ledbox-bridge-probe >/dev/null 2>&1 || { fail "could not enable ledbox-bridge-probe"; return; }
  if [ "$a" = 0 ] || [ "$b" = 0 ]; then systemctl restart ledbox-bridge-probe; else systemctl start ledbox-bridge-probe; fi \
    || { fail "could not start ledbox-bridge-probe"; return; }
  echo "  ledbox-bridge-probe: $(systemctl is-enabled ledbox-bridge-probe) / $(systemctl is-active ledbox-bridge-probe) — first check 2 min after it starts"
}

# ── hwdog ───────────────────────────────────────────────────────────────────────────────────────
HW_CONF=/etc/systemd/system.conf.d/ledbox-watchdog.conf
PANIC_CONF=/etc/sysctl.d/90-ledbox-panic.conf
WDS=/sys/class/watchdog/watchdog0
wd_holders() { # PIDs other than systemd (1) holding /dev/watchdog*
  local f p
  for f in /proc/[0-9]*/fd/*; do
    case "$(readlink "$f" 2>/dev/null)" in /dev/watchdog*) p=${f#/proc/}; p=${p%%/*}; [ "$p" != 1 ] && echo "$p" ;; esac
  done | sort -u
}
check_hwdog() {
  say "hwdog — hardware watchdog"
  if [ ! -e /dev/watchdog0 ]; then echo "  !! /dev/watchdog0 absent — is dtparam=watchdog=off in config.txt?"; return; fi
  echo "  $(cat $WDS/identity 2>/dev/null || echo '?'): state $(cat $WDS/state 2>/dev/null || echo '?'), timeout $(cat $WDS/timeout 2>/dev/null || echo '?') s, max $(cat $WDS/max_timeout 2>/dev/null || echo '?') s, nowayout $(cat $WDS/nowayout 2>/dev/null || echo '?')"
  echo "  systemd: RuntimeWatchdog=$(systemctl show -p RuntimeWatchdogUSec --value) RebootWatchdog=$(systemctl show -p RebootWatchdogUSec --value)"
  echo "  kernel.panic=$(sysctl -n kernel.panic) (seconds before a panicked kernel reboots; 0 = never)"
  local h; h=$(wd_holders)
  [ -z "$h" ] || echo "  !! held by another process: $(for p in $h; do printf '%s(%s) ' "$p" "$(cat /proc/$p/comm 2>/dev/null)"; done)"
  systemctl is-active --quiet watchdog 2>/dev/null && echo "  !! the 'watchdog' daemon package is running — it and systemd cannot both own the device"
}
apply_hwdog() {
  say "hwdog — arm the hardware watchdog through systemd"
  [ -e /dev/watchdog0 ] || { fail "/dev/watchdog0 absent — not arming anything"; return; }
  [ -z "$(wd_holders)" ] || { fail "another process holds the watchdog device ($(wd_holders)) — not arming"; return; }
  local sec=14 max rc
  max=$(cat $WDS/max_timeout 2>/dev/null || echo "")
  if [ -n "$max" ] && [ "$max" -le "$sec" ]; then sec=$((max - 1)); fi
  lp_put "$HW_CONF" 0644 <<EOF
# point-hub provisioning/setup-supervision.sh: systemd feeds the bcm2835 watchdog; a hung kernel
# or I/O stall stops the feeding and the board resets itself ${sec} s later. Hardware max ~15 s.
[Manager]
RuntimeWatchdogSec=${sec}s
RebootWatchdogSec=2min
EOF
  rc=$?; [ "$rc" = 1 ] && { fail "could not write $HW_CONF"; return; }
  if [ "$(sysctl -n kernel.panic)" = 0 ] || [ -f "$PANIC_CONF" ]; then
    lp_put "$PANIC_CONF" 0644 <<'EOF'
# point-hub provisioning/setup-supervision.sh: a panicked kernel reboots after 10 s instead of hanging
kernel.panic = 10
EOF
    [ $? = 1 ] && fail "could not write $PANIC_CONF"
    sysctl -q -p "$PANIC_CONF" || fail "sysctl kernel.panic failed"
  fi
  # Re-exec so PID 1 reads system.conf.d now rather than at the next boot. Running services are
  # untouched by a re-exec.
  if [ "$rc" = 0 ] || [ "$(systemctl show -p RuntimeWatchdogUSec --value)" = 0 ]; then
    systemctl daemon-reexec || { fail "daemon-reexec failed — takes effect at the next reboot"; return; }
    sleep 1
  fi
  local got; got=$(systemctl show -p RuntimeWatchdogUSec --value)
  echo "  now: RuntimeWatchdog=$got, device state $(cat $WDS/state 2>/dev/null || echo '?'), timeout $(cat $WDS/timeout 2>/dev/null || echo '?') s, kernel.panic=$(sysctl -n kernel.panic)"
  case "$got" in 0|infinity|"") fail "systemd did not take the watchdog setting" ;; esac
}

# ── crashlog ────────────────────────────────────────────────────────────────────────────────────
JD_CONF=/etc/systemd/journald.conf.d/ledbox.conf
check_crashlog() {
  say "crashlog — logs that survive a reset"
  echo "  journal: $([ -d /var/log/journal ] && echo persistent || echo 'volatile (RAM only — lost on every reset)'), $(journalctl --disk-usage 2>/dev/null | sed 's/.*take up //; s/ in the file system.*//')"
  echo "  boots on record: $(journalctl --list-boots --no-pager 2>/dev/null | grep -c .)"
  [ -f "$JD_CONF" ] && echo "  $JD_CONF: $(grep -v '^#' "$JD_CONF" | tr '\n' ' ')"
  local dir; dir=$(lp_bootdir) && echo "  config.txt ramoops: $(grep -E '^\s*dtoverlay=ramoops' "$dir/config.txt" 2>/dev/null || echo 'not set')"
  echo "  ramoops live: $(dmesg 2>/dev/null | grep -m1 -i 'ramoops' || echo 'no (needs the overlay + a reboot)')"
  echo "  pstore: $(ls /sys/fs/pstore 2>/dev/null | tr '\n' ' ')  saved: $(ls /var/lib/systemd/pstore 2>/dev/null | tr '\n' ' ')"
  echo "  systemd-pstore: $(systemctl is-enabled systemd-pstore 2>/dev/null)"
}
apply_crashlog() {
  say "crashlog — persistent capped journal + ramoops"
  lp_put "$JD_CONF" 0644 <<'EOF'
# point-hub provisioning/setup-supervision.sh: keep the run before a reset (journalctl -b -1),
# capped so it can never fill the card, synced every minute rather than every five.
[Journal]
Storage=persistent
SystemMaxUse=64M
SyncIntervalSec=1m
EOF
  case $? in
    0) mkdir -p /var/log/journal && systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1
       systemctl restart systemd-journald && journalctl --flush 2>/dev/null
       echo "  journald: persistent, 64 MB cap ($(journalctl --disk-usage 2>/dev/null | sed 's/.*take up //; s/ in the file system.*//'))" ;;
    1) fail "could not write $JD_CONF" ;;
  esac
  lp_config_line "dtoverlay=ramoops" || fail "config.txt not changed"
  systemctl is-enabled --quiet systemd-pstore 2>/dev/null || systemctl enable systemd-pstore >/dev/null 2>&1 || true
  echo "  ramoops needs a reboot; then: dmesg | grep -i ramoops  (expect 'ramoops: using ...')"
}

# ── main ────────────────────────────────────────────────────────────────────────────────────────
case "$MODE" in
  --check)
    for s in $STEPS; do "check_$s"; done
    ;;
  --apply)
    for s in $STEPS; do "apply_$s"; done
    if [ -n "$LP_RUN" ]; then echo; echo "  backups of everything changed: $LP_RUN   (undo: --rollback)"
    else echo; echo "  nothing needed changing"; fi
    ;;
  --rollback)
    say "rollback — the newest $LP_NAME run"
    # Stop what the restore is about to remove, while systemd still knows the unit.
    run=$(ls -1d "$LP_BACKUPS/$LP_NAME"-2* 2>/dev/null | grep -v '\.rolled-back$' | sort | tail -1)
    if [ -n "$run" ] && grep -qxF "$PROBE_UNIT" "$run/ABSENT" 2>/dev/null; then systemctl disable --now ledbox-bridge-probe >/dev/null 2>&1; fi
    wd_was_off=0
    [ -n "$run" ] && grep -q "\.wants/$WD_UNIT\.service$" "$run/ABSENT" 2>/dev/null && wd_was_off=1
    lp_restore || RC=1
    systemctl daemon-reload
    [ "$wd_was_off" = 1 ] && { systemctl stop "$WD_UNIT" 2>/dev/null; echo "  $WD_UNIT stopped again (it was disabled before)"; }
    [ -n "$run" ] && grep -qxF "$JD_CONF" "$run/PATHS" 2>/dev/null && systemctl restart systemd-journald
    # Disarming the hardware watchdog early needs a re-exec — but only where the kernel lets go of it
    # (nowayout=0). With nowayout, a re-exec that stops the feeding resets the board 15 s later.
    if [ ! -f "$HW_CONF" ] && [ "$(systemctl show -p RuntimeWatchdogUSec --value)" != 0 ]; then
      if [ "$(cat $WDS/nowayout 2>/dev/null)" = 0 ]; then systemctl daemon-reexec && echo "  hardware watchdog disarmed"
      else echo "  hardware watchdog: systemd keeps feeding it until the next reboot, which drops it (nowayout unknown or set)"; fi
    fi
    echo "  config.txt changes (ramoops) take effect at the next reboot; kernel.panic stays as is until then"
    ;;
esac

[ "$RC" = 0 ] || { echo; echo "!! one or more steps FAILED (see !! above)"; }
exit "$RC"
