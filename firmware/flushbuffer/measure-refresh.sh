#!/bin/bash
# Measure the LED panel's real refresh rate with the board's own flags, and A/B other PWM tunings
# against it. Run ON the board, with someone looking at the glass:
#
#   sudo ./measure-refresh.sh                        # 30 s with the board's current flags
#   sudo ./measure-refresh.sh -t 60 slowdown=4 slowdown=3 lsb=300
#   sudo ./measure-refresh.sh lsb=200,brightness=70  # one variant changing two things
#
# WHY. hzeller's README: below ~300 Hz a phone camera shows black bars, and --led-limit-refresh
# (setting.ini limit_refresh) locks the rate to a camera-friendly value -- but only if it is below
# the lowest rate the panel really holds. Nobody has measured this board yet; the estimate is
# 90-120 Hz at slowdown 5, limited by clocking 192 columns per plane.
#
# WHAT IT DOES
#   1. Reads the flags the running flushBuffer2 was started with (/proc/<pid>/cmdline). If none is
#      running, it starts one through bin/startled -- the boot path -- just to read them.
#   2. Stops the watchdog (it would relaunch the driver mid-run) and holds panel.lock (so a console
#      brightness change cannot restart it either), then stops the driver.
#   3. Runs flushBuffer2 by hand with --led-show-refresh for -t seconds per run: first the board's
#      flags exactly as they are, then each VARIANT, which changes only what it names.
#   4. Prints min / avg / max per run, skipping the first 2 s as hzeller's own "lowest" does, and
#      the highest multiple of 100 Hz that run could be locked to with a 4 % margin. Raw output
#      is kept (the path is printed).
#   5. Puts the board back the way it found it, whatever happens (an EXIT trap): the driver through
#      startled as the watchdog would start it, then the watchdog. Ctrl-C is safe at any point.
#
# VARIANT: comma-separated key=value, keys
#   slowdown=N    --led-slowdown-gpio         lsb=N     --led-pwm-lsb-nanoseconds
#   bits=N        --led-pwm-bits              dither=N  --led-pwm-dither-bits
#   brightness=N  --led-brightness            limit=N   --led-limit-refresh
# or a whole --led-name=value flag. Brightness does not change the refresh (hzeller scales the
# values, not the plane timing); it is there because a shorter lsb needs more brightness for the
# same light. Do not lower bits at brightness 40: it drops the low planes, which are the only lit
# ones there. Try slowdown first -- the frame is clock-bound.
#
# WHILE IT RUNS the panel shows the live scoreboard through the hand-run driver. A console
# brightness change does not apply until it is done. Look at the glass on every run: a setting that
# garbles, ghosts or flickers is out however fast it measures, and that is visible only there.
#
# Nothing here writes setting.ini or any other file of the board's. To keep a tuning, edit
# setting.ini [DISPLAY] by hand afterwards (keep a copy of the old one), then `sudo ./stopled` and
# let the watchdog start the driver again -- or reboot.
set -uo pipefail

LEDBOX=/home/pi/ledbox
BIN=$LEDBOX/bin
IMAGE=$LEDBOX/www/buffer.png
LOCK=$LEDBOX/panel.lock
WATCHDOG=ledbox-watchdog
SECS=30

say() { printf '%s\n' "$*"; }
die() { say "!! $*" >&2; exit 1; }
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit "${1:-0}"; }

flag_for() {
  case "$1" in
    slowdown) echo --led-slowdown-gpio ;;      lsb) echo --led-pwm-lsb-nanoseconds ;;
    bits) echo --led-pwm-bits ;;               dither) echo --led-pwm-dither-bits ;;
    brightness) echo --led-brightness ;;       limit) echo --led-limit-refresh ;;
    *) return 1 ;;
  esac
}
# "slowdown=4,lsb=300" -> one --led-name=value per line. Fails on anything it does not know, so a
# typo is caught before the panel is touched rather than as a driver that refuses to start.
variant_flags() {
  local IFS=, item key val f
  for item in $1; do
    case "$item" in
      --led-*=*) echo "$item" ;;
      *=*) key=${item%%=*}; val=${item#*=}
           f=$(flag_for "$key") || { say "unknown key '$key' in '$1'" >&2; return 1; }
           case "$val" in ''|*[!0-9]*) say "'$item': not a whole number" >&2; return 1 ;; esac
           echo "$f=$val" ;;
      *) say "'$item' is not key=value" >&2; return 1 ;;
    esac
  done
}

ARGS=("$@")
VARIANTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -t) SECS=${2:-}; shift 2 || shift ;;
    -t*) SECS=${1#-t}; shift ;;
    -h|--help) usage 0 ;;
    -*) say "unknown option $1" >&2; usage 2 ;;
    *) VARIANTS+=("$1"); shift ;;
  esac
done
case "$SECS" in ''|*[!0-9]*) die "-t takes whole seconds" ;; esac
[ "$SECS" -ge 5 ] || die "-t: at least 5 seconds (the first 2 of each run are skipped)"
for v in "${VARIANTS[@]}"; do variant_flags "$v" >/dev/null || die "bad variant '$v' (see --help)"; done

[ "$(id -u)" = 0 ] || exec sudo -- "$0" "${ARGS[@]}"

[ -x "$BIN/flushBuffer2" ] || die "no $BIN/flushBuffer2"
[ -x "$BIN/startled" ] || die "no $BIN/startled"
command -v timeout >/dev/null || die "needs timeout (coreutils)"

driver_pids() { pgrep -x flushBuffer2; }
# The normal start, as the watchdog's start_panel does it: startled under its own transient unit,
# so the driver outlives this script. fd 9 (panel.lock) is closed for it, or the driver would hold
# the lock for its whole life and lock every later restart out.
start_driver() {
  systemd-run --quiet --collect --unit="ledbox-panel-measure-$$-$RANDOM" "$BIN/startled" >/dev/null 2>&1 9>&- ||
    { ( cd "$BIN" && exec ./startled ) >/dev/null 2>&1 9>&- & }
  for _ in $(seq 50); do driver_pids >/dev/null && return 0; sleep 0.2; done
  return 1
}
stop_driver() {
  driver_pids >/dev/null || return 0
  pkill -x flushBuffer2
  for _ in $(seq 25); do driver_pids >/dev/null || return 0; sleep 0.2; done
  return 1
}

OUT=$(mktemp -d /tmp/measure-refresh.XXXXXX) || die "no temp dir"
chmod 755 "$OUT"   # the driver drops to `daemon` and must still reach its --ctl-dir under here
RESTORE_DRIVER=0 RESTORE_WATCHDOG=0 RESTORED=0 RUNS=0 RUN_PID=
restore() {
  [ "$RESTORED" = 1 ] && return
  RESTORED=1
  say ""
  say "== putting the board back"
  [ -n "$RUN_PID" ] && kill -INT "$RUN_PID" 2>/dev/null
  stop_driver || say "!! a hand-run flushBuffer2 would not stop -- check: pgrep -a flushBuffer2"
  if [ "$RESTORE_DRIVER" = 1 ]; then
    if start_driver; then say "   panel driver running again (bin/startled, the board's own flags)"
    else say "!! the panel driver did not come back -- start it: sudo systemd-run --collect $BIN/startled"; fi
  fi
  exec 9>&-
  if [ "$RESTORE_WATCHDOG" = 1 ]; then
    if systemctl start "$WATCHDOG"; then say "   $WATCHDOG running again"
    else say "!! $WATCHDOG did not start -- sudo systemctl start $WATCHDOG"; fi
  fi
  say "   raw output kept in $OUT"
}
trap restore EXIT
trap 'exit 130' INT TERM HUP

say "== stopping what supervises the panel driver"
if systemctl is-active --quiet "$WATCHDOG" 2>/dev/null; then
  RESTORE_WATCHDOG=1
  systemctl stop "$WATCHDOG" || die "could not stop $WATCHDOG"
  say "   $WATCHDOG stopped"
else
  say "   $WATCHDOG was not running (and will not be started afterwards)"
fi
exec 9>>"$LOCK" || die "cannot open $LOCK"
flock -w 30 9 || die "$LOCK stayed busy for 30 s (a brightness restart in progress?) -- try again"

BASE=()
pid=$(driver_pids | head -n 1)
if [ -n "$pid" ]; then
  RESTORE_DRIVER=1
else
  say "   no flushBuffer2 running: starting one through startled, only to read its flags"
  start_driver || die "startled did not bring up a flushBuffer2 -- run it by hand to see why: cd $BIN && sudo ./startled"
  pid=$(driver_pids | head -n 1)
fi
[ "$(driver_pids | wc -l)" -le 1 ] || say "   (more than one flushBuffer2 was running -- the vertical-flicker fault; all are stopped now)"
# Everything after the image path, minus what each run sets itself.
first=1
while IFS= read -r -d '' a; do
  if [ "$first" = 1 ]; then first=0; continue; fi
  case "$a" in
    --led-show-refresh|--led-no-show-refresh|--ctl-dir=*) ;;
    -*) BASE+=("$a") ;;
  esac
done < "/proc/$pid/cmdline"
[ "${#BASE[@]}" -gt 0 ] || die "could not read the driver's flags from /proc/$pid/cmdline"
say "   the board's flags: ${BASE[*]}"
stop_driver || die "flushBuffer2 did not stop within 5 s -- not starting a second one beside it"
say "   panel driver stopped"

# show-refresh prints "\b\b\b\b\b\b\b\b%6.1fHz" every frame, plus " (lowest: %.1fHz)" whenever a
# new slowest frame turns up after the first 2 s. -> "min avg max lowest samples".
summarize() {
  tr '\b\r' '\n\n' < "$1" | awk -v secs="$SECS" '
    { line = $0
      if (match(line, /\(lowest: [0-9.]+Hz\)/)) {
        s = substr(line, RSTART, RLENGTH); gsub(/[^0-9.]/, "", s); lowest = s
        line = substr(line, 1, RSTART - 1)
      }
      if (match(line, /[0-9]+\.[0-9]+Hz/)) v[n++] = substr(line, RSTART, RLENGTH - 2) + 0 }
    END {
      if (n == 0) { print "- - - - 0"; exit }
      skip = int(n * 2 / secs); if (skip >= n) skip = 0
      min = 1e9; max = 0; sum = 0
      for (i = skip; i < n; i++) { x = v[i]; sum += x; if (x < min) min = x; if (x > max) max = x }
      printf "%.1f %.1f %.1f %s %d\n", min, sum / (n - skip), max, (lowest == "" ? "-" : lowest), n - skip }'
}

ROWS=()
run_one() {   # label, flags...
  local label=$1; shift
  RUNS=$((RUNS + 1))
  local out="$OUT/run$RUNS.out" err="$OUT/run$RUNS.err" rc
  say ""
  say "== run $RUNS of $((1 + ${#VARIANTS[@]})): $label, ${SECS} s -- look at the panel"
  say "   $BIN/flushBuffer2 $IMAGE $* --led-show-refresh"
  # In the background and waited for: a trapped Ctrl-C interrupts `wait` at once, where a
  # foreground command would hold the trap back until the run is over.
  timeout -k 5 -s INT "$SECS" "$BIN/flushBuffer2" "$IMAGE" "$@" --led-show-refresh --ctl-dir="$OUT/ctl" \
    >"$out" 2>"$err" 9>&- &
  RUN_PID=$!
  wait "$RUN_PID"; rc=$?
  RUN_PID=
  local min avg max lowest n lock
  read -r min avg max lowest n < <(summarize "$out")
  if [ "$rc" != 124 ] && [ "$n" = 0 ]; then
    say "!! flushBuffer2 exited ($rc) without measuring:"; sed 's/^/   /' "$err" | tail -n 5
    ROWS+=("$RUNS|FAILED|-|-|-|-|-|$label")
  else
    lock=$(awk -v m="$min" 'BEGIN { l = int(m / 1.04 / 100) * 100; print (l >= 100 ? l : "-") }')
    say "   min $min Hz   avg $avg Hz   max $max Hz   (hzeller's lowest: $lowest Hz, $n frames)"
    ROWS+=("$RUNS|$min|$avg|$max|$lowest|$lock|$n|$label")
  fi
  sleep 1   # the GPIO is free again before the next run
}

run_one "the board as it is" "${BASE[@]}"
for v in "${VARIANTS[@]}"; do
  flags=("${BASE[@]}")
  while IFS= read -r f; do
    name=${f%%=*}
    kept=()
    for x in "${flags[@]}"; do [ "${x%%=*}" = "$name" ] || kept+=("$x"); done
    flags=("${kept[@]}" "$f")
  done < <(variant_flags "$v")
  run_one "$v" "${flags[@]}"
done

say ""
say "== summary (Hz; 'lock' = the highest multiple of 100 that run's min holds with 4 % margin)"
printf '   %-4s %8s %8s %8s %8s %6s %7s  %s\n' run min avg max lowest lock frames variant
for row in "${ROWS[@]}"; do
  IFS='|' read -r r min avg max lowest lock n label <<<"$row"
  printf '   %-4s %8s %8s %8s %8s %6s %7s  %s\n' "$r" "$min" "$avg" "$max" "$lowest" "$lock" "$n" "$label"
done
say ""
say "   A run counts only if the panel looked right during it. To keep one: setting.ini [DISPLAY]"
say "   (slowdown_gpio, pwm_lsb_nanoseconds, ... and limit_refresh=<lock>), then restart the driver."
