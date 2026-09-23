#!/bin/bash
# KSCW LedBox watchdog.
#
# The vendor boot flow starts the app and the LED panel driver exactly once
# (rc.local -> bin/start). If either dies, the board goes dark until someone
# power-cycles it -- which, mid-match, means the scoreboard is simply gone.
#
# This keeps three things true, checking every 30s:
#   1. the scoreboard app is running
#   2. the LED panel driver (flushBuffer2) is running
#   3. the app is still PAINTING -- www/buffer.png is rewritten every frame
#      (~5 fps for the vendor ledbox.py; openscore only paints on change, so it
#      re-saves the current frame on a heartbeat well inside STALE_AFTER), so a
#      stale file means the render thread died even though the
#      process is alive and still answering on port 8889. That failure is
#      invisible from the network: the bridge still reports "connected" while
#      the panel is frozen on the last frame.
#
# Restarting is always preferred over rebooting: a restart costs ~10s, a reboot
# costs ~60s and drops the wifi AP with it.

BUFFER=/home/pi/ledbox/www/buffer.png
STALE_AFTER=60      # seconds without a repaint before we call the renderer dead
CHECK_EVERY=30
PANEL_OFF=/home/pi/ledbox/PANEL_OFF   # present = operator set brightness 0; keep the panel dark
LOCK=/home/pi/ledbox/panel.lock       # serialises panel starts so we never spawn two drivers
# The bridge's persisted settings -- read only to spot a PANEL_OFF left behind (see below).
BRIDGE_SETTINGS=/home/pi/ledbox-bridge/settings.json

log() { logger -t ledbox-watchdog "$1"; echo "$(date '+%F %T') $1"; }

# Monotonic seconds since boot. Deliberately NOT `date +%s`: this board has no RTC, so the first
# successful NTP sync after the wifi uplink comes up steps the wall clock by hours in a single
# jump. The old staleness check was `date +%s` minus buffer.png's mtime, so at that instant every
# file on the box looked hours stale and the watchdog pkill'd a perfectly healthy scoreboard app
# -- triggered by the exact event the uplink was added to cause, and mid-match if the match began
# before NTP landed. Uptime cannot step, and "has the mtime CHANGED" does not care what the mtime
# actually is, so both sides of the comparison are now immune to a clock jump.
uptime_s() { awk '{print int($1)}' /proc/uptime; }

# Either renderer: the vendor ledbox.py, or openscore once startledbox is switched to it (openscore
# ROADMAP Phase 3-4). Matching only ledbox.py made openscore look dead forever, so every tick
# relaunched startledbox on top of the live one -- and the frozen-panel pkill never hit it.
APP_PATTERN='python3 -u (ledbox|openscore)[.]py'
app_running()   { pgrep -f "$APP_PATTERN" >/dev/null 2>&1; }
# Match the driver by exact process name, not cmdline: the transient `sudo` wrapper around it
# also carries "bin/flushBuffer2" in its args, and counting that as "running" during a restart
# is what let a second driver spawn (vertical flicker). Kills below use the same `-x`.
panel_running() { pgrep -x flushBuffer2 >/dev/null 2>&1; }

start_app() { ( cd /home/pi/ledbox/bin && ./startledbox >/dev/null 2>&1 & ) ; }
# Start exactly one driver, under a lock the bridge shares: the pgrep recheck inside flock means
# a watchdog start racing a brightness-change restart can't leave two drivers fighting the GPIO
# (that duplicate is what shows as vertical flicker on the panel).
#
# The lock must cover the whole start, not just the fork. startled spends up to ~1s sourcing the
# ini parser, copying the splash and going through sudo before any process is NAMED flushBuffer2,
# and in that gap a second starter's pgrep sees nothing and forks another driver. So after forking
# we keep the lock until the driver is visible (bounded: 10s, then give up and let the next tick
# retry).
#   -o  the lock fd is NOT handed to the command -- without it the backgrounded startled (and the
#       bash that waits on sudo for the driver's whole life) inherit it, and the "lock" is then
#       held for as long as the panel runs, so the next starter blocks until the driver dies.
#   -w  a lock someone else holds far too long (a starter WITHOUT -o, e.g. an older bridge)
#       must not hang this loop: the app check below it is the one that matters mid-match.
#
# The driver is launched as its OWN transient systemd unit, same as the bridge's PANEL_RESTART
# (src/controlServer.js). A backgrounded startled only leaves the shell, not the cgroup: when this
# script runs as a service, the driver it starts is a member of that unit, and stopping or
# restarting the watchdog (a deploy, `systemctl restart`) takes the panel dark with it. We run as
# root, so no sudo and no --uid: the driver runs as the same user it always did from here. $$ keeps
# the unit name unique while a previous one is still being reaped; --collect drops it once the
# driver exits. Should systemd-run be missing or refused, the old in-cgroup launch still lights the
# panel -- dark is the worse fault.
start_panel() {
    flock -o -w 20 "$LOCK" -c '
        pgrep -x flushBuffer2 >/dev/null 2>&1 && exit 0
        systemd-run --quiet --collect --unit=ledbox-panel-$$ /home/pi/ledbox/bin/startled >/dev/null 2>&1 ||
            { ( cd /home/pi/ledbox/bin && exec ./startled ) >/dev/null 2>&1 & }
        for _ in $(seq 50); do pgrep -x flushBuffer2 >/dev/null 2>&1 && exit 0; sleep 0.2; done
        exit 3'
    case $? in
        0) ;;
        3) log "panel driver did not appear within 10s of startled -> will retry" ;;
        *) log "panel.lock busy for 20s -> skipped this start, will retry" ;;
    esac
}

# PANEL_OFF is written by the bridge on brightness 0 and removed only when brightness is next
# CHANGED to >0. So a flag that outlives its reason -- settings restored or reset to 40 while the
# file stayed, or left from a session without the bridge -- keeps the panel dark on every boot
# while the UI shows 40%, and re-saving 40 does nothing (no change, no call). The bridge saves
# settings.json BEFORE it writes the flag, so a flag alongside a saved brightness > 0 cannot be a
# brightness-0 in progress: it is stale, and clearing it is what the operator asked for. Anything
# we cannot read (no file, no key, bad JSON, no python3) keeps the flag: a dark panel the log
# explains beats lighting one the operator switched off.
saved_brightness() {
    python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get("brightness"); print(v if isinstance(v,(int,float)) and not isinstance(v,bool) else "")' \
        "$BRIDGE_SETTINGS" 2>/dev/null
}
panel_off_requested() {
    [ -f "$PANEL_OFF" ] || return 1
    local b; b=$(saved_brightness)
    if [ -n "$b" ] && awk -v b="$b" 'BEGIN { exit !(b > 0) }'; then
        log "stale PANEL_OFF (settings.json brightness=$b) -> removing it, panel stays on"
        rm -f "$PANEL_OFF"
        return 1
    fi
    return 0
}

# Let the normal boot sequence finish before policing it.
sleep 90
log "watchdog started"

# Last mtime we saw on buffer.png, and the uptime at which it last changed. Empty last_mtime
# means "no reading yet", which the first tick fills in.
last_mtime=""
last_paint=$(uptime_s)
panel_off_logged=""   # log the dark-on-purpose state on entry/exit, not every 30s

while true; do
    if ! app_running; then
        log "app not running -> starting"
        start_app
        sleep 25          # give it time to bind its sockets before re-checking
        last_mtime=""; last_paint=$(uptime_s)
    elif [ -f "$BUFFER" ]; then
        mtime=$(stat -c %Y "$BUFFER" 2>/dev/null || echo 0)
        if [ "$mtime" != "$last_mtime" ]; then
            last_mtime="$mtime"
            last_paint=$(uptime_s)
        fi
        age=$(( $(uptime_s) - last_paint ))
        if [ "$age" -gt "$STALE_AFTER" ]; then
            log "panel frozen (buffer.png unchanged for ${age}s) -> restarting app"
            pkill -f "$APP_PATTERN"
            sleep 3
            start_app
            sleep 25
            # Reset the clock on the new process, else the next tick re-reads the age we just
            # acted on and restarts it all over again.
            last_mtime=""; last_paint=$(uptime_s)
        fi
    fi

    # Checked after the app: startledbox also brings the panel up, so this
    # avoids racing it during a restart.
    if panel_off_requested; then
        # Operator set brightness 0 to save power. Keep the panel dark, and stop it if
        # anything (a boot, an app restart) brought it back up. Said once, so "why is the panel
        # dark" has an answer in journalctl -t ledbox-watchdog without flooding it every 30s.
        if [ -z "$panel_off_logged" ]; then
            log "PANEL_OFF present (brightness 0, since $(date -r "$PANEL_OFF" '+%F %T' 2>/dev/null || echo '?')) -> keeping the panel dark"
            panel_off_logged=1
        fi
        if panel_running; then
            log "panel off requested (brightness 0) -> stopping driver"
            pkill -x flushBuffer2
        fi
    else
        if [ -n "$panel_off_logged" ]; then
            log "PANEL_OFF cleared -> panel back under watch"
            panel_off_logged=""
        fi
        if ! panel_running; then
            log "panel driver not running -> starting"
            start_panel
            sleep 10
        fi
    fi

    sleep "$CHECK_EVERY"
done
