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
#      (~5 fps), so a stale file means the render thread died even though the
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

log() { logger -t ledbox-watchdog "$1"; echo "$(date '+%F %T') $1"; }

# Monotonic seconds since boot. Deliberately NOT `date +%s`: this board has no RTC, so the first
# successful NTP sync after the wifi uplink comes up steps the wall clock by hours in a single
# jump. The old staleness check was `date +%s` minus buffer.png's mtime, so at that instant every
# file on the box looked hours stale and the watchdog pkill'd a perfectly healthy scoreboard app
# -- triggered by the exact event the uplink was added to cause, and mid-match if the match began
# before NTP landed. Uptime cannot step, and "has the mtime CHANGED" does not care what the mtime
# actually is, so both sides of the comparison are now immune to a clock jump.
uptime_s() { awk '{print int($1)}' /proc/uptime; }

app_running()   { pgrep -f "python3 -u ledbox.py" >/dev/null 2>&1; }
# Match the driver by exact process name, not cmdline: the transient `sudo` wrapper around it
# also carries "bin/flushBuffer2" in its args, and counting that as "running" during a restart
# is what let a second driver spawn (vertical flicker). Kills below use the same `-x`.
panel_running() { pgrep -x flushBuffer2 >/dev/null 2>&1; }

start_app() { ( cd /home/pi/ledbox/bin && ./startledbox >/dev/null 2>&1 & ) ; }
# Start exactly one driver, under a lock the bridge shares: the pgrep recheck inside flock means
# a watchdog start racing a brightness-change restart can't leave two drivers fighting the GPIO
# (that duplicate is what shows as vertical flicker on the panel).
start_panel() { flock "$LOCK" -c 'pgrep -x flushBuffer2 >/dev/null 2>&1 || ( cd /home/pi/ledbox/bin && ./startled >/dev/null 2>&1 & )' ; }

# Let the normal boot sequence finish before policing it.
sleep 90
log "watchdog started"

# Last mtime we saw on buffer.png, and the uptime at which it last changed. Empty last_mtime
# means "no reading yet", which the first tick fills in.
last_mtime=""
last_paint=$(uptime_s)

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
            pkill -f "python3 -u ledbox.py"
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
    if [ -f "$PANEL_OFF" ]; then
        # Operator set brightness 0 to save power. Keep the panel dark, and stop it if
        # anything (a boot, an app restart) brought it back up.
        if panel_running; then
            log "panel off requested (brightness 0) -> stopping driver"
            pkill -x flushBuffer2
        fi
    elif ! panel_running; then
        log "panel driver not running -> starting"
        start_panel
        sleep 10
    fi

    sleep "$CHECK_EVERY"
done
