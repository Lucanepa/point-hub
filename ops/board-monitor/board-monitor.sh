#!/bin/bash
# board-monitor.sh — watch the KSCW LED scoreboard (the LedBox C0270 board) from lenovoserver.
#
# In October 2026 the board was off the tailnet for 19 days and nobody noticed. Tailscale has no
# "device offline" webhook, and everything the board knows about its own health (throttle sticky
# bits, temperature, disk, clock sync) was only ever visible on the scorer's tablet. So this box
# looks, every 10 minutes (board-monitor.timer):
#
#   1. Online / LastSeen of the board's tailnet node, from `tailscale status --json`.
#   2. When the node is online: GET /generate_204 on :8890 (is the appliance answering?) and, once
#      an hour, the open health routes GET /api/system, /api/status, /api/uplink plus the expiry of
#      the console's TLS certificate on :8891. Every run appends one row to board.db (SQLite).
#   3. ntfy (homelab topic) ONLY when something needs doing:
#        offline > 6 h with a KSCW home game in the next 72 h  (public Directus games list)
#        under-voltage, now or sticky since boot               (/api/system cpu.throttle)
#        disk > 85 %                                           (/api/system disk.usedPct)
#        clock not synced, after 30 min of uptime              (/api/system clock.synced)
#        TLS certificate valid for < 20 more days              (:8891 handshake)
#        appliance not answering while the node is online      (:8890)
#      plus ONE "back online" message after an outage of > 6 h, and a "monitor is blind" message
#      when tailscale on this box is not running (so a dead monitor never reads as a quiet board).
#   4. One alert per condition per day (state.json next to this script).
#   5. Once a night (03:00-06:59; or after 44 h without a pull, but never within 3 h of a home
#      game), the new board log lines go to the NAS: nas-ts:/volume1/backups/ledbox-board/<year>/.
#      Both log routes are open GETs (no PIN, no token): /api/logs?sinceId= for the delta while the
#      board process is the same one as last time, /api/logs/export (whole trail, up to ~15 MB)
#      after a restart, filtered to lines newer than the last one pulled.
#
# Why the health routes only hourly: every /api/* request counts as "a console is watching"
# (controlServer.js handleApi -> ledbox.noteViewer()), which swaps the idle QR screen for the wall
# clock for 20 s. /generate_204 is answered before handleApi, so the 10-minute probe leaves the
# panel alone.
#
# Usage: board-monitor.sh [--dry-run] [--pull-logs]
#   --dry-run    read everything, print what it would alert; no ntfy, no board.db / state / NAS writes
#   --pull-logs  pull the board's logs to the NAS now (the board must still be reachable)
#
# No secrets: every board route used here is an open GET, the games list is a public read, ntfy is
# local. The board's address is resolved from its tailnet node name at run time, never stored.
# Settings below can be overridden from the environment (systemctl edit board-monitor.service).
set -uo pipefail

HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
NODE=${BOARD_NODE:-ledbox-c0270}
HTTP_PORT=${BOARD_HTTP_PORT:-8890}
HTTPS_PORT=${BOARD_HTTPS_PORT:-8891}
NTFY=${NTFY_URL:-http://127.0.0.1:8445/homelab}
DIRECTUS=${DIRECTUS_URL:-https://directus.kscw.ch}
HALLS_RE=${BOARD_HALLS_RE:-^KWI}           # halls the board serves (case-insensitive, on hall.name)
NAS=${NAS_HOST:-nas-ts}
NAS_DIR=${NAS_DIR:-/volume1/backups/ledbox-board}
DATA=${BOARD_MONITOR_DATA:-$HERE}
DB=$DATA/board.db
STATE=$DATA/state.json
GAMES_CACHE=$DATA/games-cache.json

OFFLINE_H=6          # offline longer than this counts as an outage
GAME_AHEAD_H=72      # ... and is worth an alert when a home game starts within this
DISK_PCT=85
TLS_DAYS=20
HEALTH_EVERY_MIN=60  # health routes at most this often (see the header)
CLOCK_GRACE_S=1800   # NTP gets this long after boot before "not synced" counts
SSHO=(-o BatchMode=yes -o ConnectTimeout=20)

DRY=0
FORCE_LOGS=0
for a in "$@"; do
  case $a in
    --dry-run) DRY=1 ;;
    --pull-logs) FORCE_LOGS=1 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown option: $a (try --help)" >&2; exit 2 ;;
  esac
done

mkdir -p "$DATA"
exec 9>"$DATA/.lock"
flock -n 9 || { echo "another board-monitor run is still going; skipping"; exit 0; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

NOW=$(date +%s)
TODAY=$(date +%F)
HOUR=$((10#$(date +%H)))
RC=0
[ $DRY = 1 ] && echo "DRY RUN — nothing is posted or written"

# ---------------------------------------------------------------------------------------------
# helpers

when() { date -d "@$1" '+%a %d.%m. %H:%M'; }
dur() {
  local s=$1
  if [ "$s" -ge 86400 ]; then echo "$((s / 86400)) d $(((s % 86400) / 3600)) h"
  elif [ "$s" -ge 3600 ]; then echo "$((s / 3600)) h $(((s % 3600) / 60)) min"
  else echo "$((s / 60)) min"; fi
}
epoch() { # ISO time -> epoch, empty for missing / Go's zero time
  case ${1:-} in ''|0001-*|null) return 0 ;; esac
  date -d "$1" +%s 2>/dev/null || true
}

if [ -s "$STATE" ] && jq -e 'type == "object"' "$STATE" >/dev/null 2>&1; then ST=$(cat "$STATE"); else ST='{}'; fi
st() { jq -r "$1 | if . == null then \"\" else tostring end" <<<"$ST"; }
st_set() { ST=$(jq "$@" <<<"$ST"); }
save_state() {
  [ $DRY = 1 ] && return 0
  printf '%s\n' "$ST" >"$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
}

db() {
  [ $DRY = 1 ] && return 0
  sqlite3 -batch "$DB" ".timeout 5000" "$@"
}
db_init() {
  db "CREATE TABLE IF NOT EXISTS samples (
        ts TEXT NOT NULL,              -- UTC, this host's clock
        online INTEGER,                -- tailscale: node Online
        last_seen TEXT,                -- tailscale: node LastSeen (set while offline)
        reachable INTEGER,             -- GET /generate_204 on :8890 answered 204
        probe_ms INTEGER,
        health INTEGER NOT NULL DEFAULT 0, -- 1 = the columns below were read in this run
        uptime_s INTEGER, temp_c REAL, load1 REAL,
        throttle_raw TEXT, under_voltage_now INTEGER, ever_under_voltage INTEGER,
        ever_throttled INTEGER, ever_freq_capped INTEGER, ever_soft_temp INTEGER,
        disk_pct REAL, mem_pct REAL, bytes_written INTEGER,
        clock_synced INTEGER, last_sync_at TEXT, clock_skew_s INTEGER,
        tls_days INTEGER,
        uplink TEXT, uplink_valid_until TEXT,
        sport TEXT, build TEXT, panel_connected INTEGER, mode TEXT);
      CREATE INDEX IF NOT EXISTS samples_ts ON samples(ts);
      CREATE TABLE IF NOT EXISTS alerts (ts TEXT NOT NULL, key TEXT NOT NULL, priority TEXT,
        title TEXT, message TEXT, posted INTEGER);
      CREATE TABLE IF NOT EXISTS log_pulls (ts TEXT NOT NULL, mode TEXT, lines INTEGER,
        bytes INTEGER, file TEXT, ok INTEGER, note TEXT);"
}
# A JSON object -> INSERT. Values are quoted by jq, never pasted into SQL by the shell.
sql_insert() { # table json
  jq -r --arg t "$1" '
    def q: if . == null then "NULL"
           elif type == "boolean" then (if . then "1" else "0" end)
           elif type == "number" then tostring
           else "'"'"'" + (tostring | gsub("'"'"'"; "'"'"''"'"'")) + "'"'"'" end;
    "INSERT INTO \($t) (" + (keys_unsorted | join(",")) + ") VALUES (" + ([.[] | q] | join(",")) + ");"' <<<"$2"
}
db_row() { db "$(sql_insert "$1" "$2")"; }

# post PRIORITY TAGS TITLE MESSAGE KEY — straight to ntfy (titles stay ASCII: they are headers)
post() {
  local prio=$1 tags=$2 title=$3 msg=$4 key=$5 ok=0
  if [ $DRY = 1 ]; then
    printf 'WOULD ALERT [%s] %s\n%s\n' "$prio" "$title" "$(sed 's/^/    /' <<<"$msg")"
    return 0
  fi
  if curl -fsS -m 15 -H "Title: $title" -H "Priority: $prio" -H "Tags: $tags" -d "$msg" "$NTFY" >/dev/null; then
    ok=1
    printf 'ALERTED [%s] %s\n%s\n' "$prio" "$title" "$(sed 's/^/    /' <<<"$msg")"
  else
    echo "ntfy post FAILED ($key: $title) — retried next run" >&2
    RC=1
  fi
  db_row alerts "$(jq -n -c --arg ts "$(date -u +%FT%TZ)" --arg k "$key" --arg p "$prio" --arg t "$title" \
    --arg m "$msg" --argjson ok $ok '{ts:$ts, key:$k, priority:$p, title:$t, message:$m, posted:$ok}')"
  return $((1 - ok))
}
# alert KEY PRIORITY TAGS TITLE MESSAGE — at most once per KEY per day
alert() {
  local key=$1
  if [ "$(st ".alerted[\"$key\"]")" = "$TODAY" ]; then
    echo "already alerted today: $key ($4)"
    return 0
  fi
  if post "$2" "$3" "$4" "$5" "$key" && [ $DRY = 0 ]; then
    st_set --arg k "$key" --arg d "$TODAY" '.alerted[$k] = $d'
  fi
}

# The public games list (the same token-free read the board's seasonSchedule.js makes), cached an
# hour. A stale copy (< 7 days) beats no answer when Directus is down.
games_json() {
  local age=999999 out from
  [ -s "$GAMES_CACHE" ] && age=$((NOW - $(stat -c %Y "$GAMES_CACHE")))
  if [ "$age" -lt 3600 ]; then cat "$GAMES_CACHE"; return 0; fi
  from=$(date -d '-1 day' +%F)
  if out=$(curl -fsS -m 20 -G "$DIRECTUS/items/games" -H 'Accept: application/json' \
        --data-urlencode "filter={\"date\":{\"_gte\":\"$from\"},\"type\":{\"_eq\":\"home\"}}" \
        --data-urlencode 'sort=date,time' --data-urlencode 'limit=-1' \
        --data-urlencode 'fields=id,date,time,home_team,away_team,status,league,kscw_team.sport,hall.name') \
     && jq -e '.data | type == "array"' <<<"$out" >/dev/null 2>&1; then
    if [ $DRY = 0 ]; then printf '%s' "$out" >"$GAMES_CACHE.tmp" && mv -f "$GAMES_CACHE.tmp" "$GAMES_CACHE"; fi
    printf '%s' "$out"
    return 0
  fi
  if [ "$age" -lt $((7 * 86400)) ]; then
    echo "games list unavailable — using the copy from $(dur "$age") ago" >&2
    cat "$GAMES_CACHE"
    return 0
  fi
  return 1
}
# home games (in the board's halls, not cancelled/postponed) with kickoff between two epochs,
# one line each: "<epoch>\t<Thu 22.10. 20:00 Home - Away (Hall)>"
games_between() { # from_epoch to_epoch
  local g
  g=$(games_json) || return 1
  jq -r --arg from "$(date -d "@$1" '+%F %H:%M')" --arg to "$(date -d "@$2" '+%F %H:%M')" --arg halls "$HALLS_RE" '
    [ .data[]
      | select((.status // "" | ascii_downcase) as $s | $s != "cancelled" and $s != "postponed")
      | select((.hall.name // "") | test($halls; "i"))
      | . + {k: "\(.date) \((.time // "00:00")[0:5])"}
      | select(.k >= $from and .k <= $to) ]
    | unique_by(.k + "|" + .home_team + "|" + .away_team) | sort_by(.k) | .[]
    | "\(.k)\t\(.date | strptime("%Y-%m-%d") | strftime("%a %d.%m.")) \(.k[11:16]) \(.home_team) - \(.away_team) (\(.hall.name))"' <<<"$g"
}

# ---------------------------------------------------------------------------------------------
# 1. what the tailnet says

db_init
TS=$(timeout 20 tailscale status --json 2>/dev/null) || TS=''
BACKEND=unknown
[ -n "$TS" ] && BACKEND=$(jq -r '.BackendState // "unknown"' <<<"$TS" 2>/dev/null || echo unknown)
if [ "$BACKEND" != Running ]; then
  echo "tailscale on this host is not running (BackendState=$BACKEND) — cannot see the board"
  alert monitor_blind high warning "Board monitor is blind" \
    "tailscale on lenovoserver is not running (state: $BACKEND), so the scoreboard's status cannot be read. Check: tailscale status; journalctl -u tailscaled"
  save_state
  exit 1
fi
PEER=$(jq -c --arg n "$NODE" '[.Peer[]? | select(.HostName == $n or ((.DNSName // "") | split(".")[0]) == $n)] | first // empty' <<<"$TS")
if [ -z "$PEER" ]; then
  echo "$NODE: not in the tailnet"
  alert node_missing high warning "Scoreboard missing from the tailnet" \
    "There is no node named $NODE in tailscale status: it was removed or renamed. Check the admin console (Machines); if it was renamed, set BOARD_NODE for board-monitor."
  save_state
  exit 0
fi

ONLINE=$(jq -r '.Online == true' <<<"$PEER")
LAST_SEEN=$(jq -r '.LastSeen // empty' <<<"$PEER")
LS_EPOCH=$(epoch "$LAST_SEEN")
IP=$(jq -r '[.TailscaleIPs[]? | select(test("^[0-9.]+$"))][0] // empty' <<<"$PEER")
FQDN=$(jq -r '.DNSName // "" | rtrimstr(".")' <<<"$PEER")
PREV_ONLINE=$(st '.node.online')
PREV_SINCE=$(st '.node.offline_since')

# ---------------------------------------------------------------------------------------------
# 2. is the appliance answering? (+ hourly health)

REACHABLE=null PROBE_MS=null PROBE_CODE=''
if [ "$ONLINE" = true ] && [ -n "$IP" ]; then
  for try in 1 2; do
    r=$(curl -s -o /dev/null -m 10 -w '%{http_code} %{time_total}' "http://$IP:$HTTP_PORT/generate_204") || true
    PROBE_CODE=${r%% *}
    if [ "$PROBE_CODE" = 204 ]; then
      REACHABLE=true
      PROBE_MS=$(awk -v t="${r#* }" 'BEGIN { printf "%d", t * 1000 }')
      break
    fi
    REACHABLE=false
    [ $try = 1 ] && sleep 5
  done
fi

if [ "$ONLINE" = true ]; then
  echo "$NODE: online; appliance $([ "$REACHABLE" = true ] && echo "answering (${PROBE_MS} ms)" || echo "NOT answering ($([ "${PROBE_CODE:-000}" = 000 ] && echo "no connection" || echo "HTTP $PROBE_CODE"))")"
else
  OFF_FROM=${LS_EPOCH:-${PREV_SINCE:-$NOW}}
  echo "$NODE: OFFLINE for $(dur $((NOW - OFF_FROM))) (last seen $(when "$OFF_FROM"))"
fi

SYS=null STATUS=null UPL=null TLS=null HEALTH=0
LAST_HEALTH=$(st '.last_health_at')
if [ "$REACHABLE" = true ] && { [ $DRY = 1 ] || [ -z "$LAST_HEALTH" ] || [ "$PREV_ONLINE" != true ] ||
     [ $((NOW - LAST_HEALTH)) -ge $((HEALTH_EVERY_MIN * 60 - 120)) ]; }; then
  get() { curl -fsS -m 15 --max-filesize 1048576 "http://$IP:$HTTP_PORT$1" 2>/dev/null | jq -c 'select(type == "object")' 2>/dev/null; }
  SYS=$(get /api/system); SYS=${SYS:-null}
  STATUS=$(get /api/status); STATUS=${STATUS:-null}
  UPL=$(get /api/uplink); UPL=${UPL:-null}
  if [ -n "$FQDN" ]; then
    END=$(timeout 20 openssl s_client -connect "$IP:$HTTPS_PORT" -servername "$FQDN" </dev/null 2>/dev/null \
          | openssl x509 -noout -enddate 2>/dev/null) || END=''
    END=${END#notAfter=}
    [ -n "$END" ] && TLS=$(( ($(date -d "$END" +%s) - NOW) / 86400 ))
  fi
  HEALTH=1
  [ $DRY = 0 ] && st_set --argjson t "$NOW" '.last_health_at = $t'
  jq -r --argjson tls "$TLS" '"health: up \((.host.uptimeSec // 0) / 3600 | floor) h, \(.cpu.tempC // "?") C, throttle \(.cpu.throttle.raw // "?"), disk \(.disk.usedPct // "?") %, clock synced \(.clock.synced), TLS \($tls // "?") d"' <<<"$SYS"
fi

# one row per run
ROW=$(jq -n -c --arg ts "$(date -u +%FT%TZ)" --argjson online "$ONLINE" --arg ls "$LAST_SEEN" \
  --argjson reach "$REACHABLE" --argjson ms "$PROBE_MS" --argjson health $HEALTH --argjson now "$NOW" \
  --argjson sys "$SYS" --argjson st "$STATUS" --argjson up "$UPL" --argjson tls "$TLS" '
  def b: if . == null then null else (. == true) end;
  { ts: $ts, online: $online,
    last_seen: (if $online or $ls == "" or ($ls | startswith("0001")) then null else $ls end),
    reachable: $reach, probe_ms: $ms, health: $health,
    uptime_s: $sys.host.uptimeSec, temp_c: $sys.cpu.tempC, load1: ($sys.cpu.load // [])[0],
    throttle_raw: $sys.cpu.throttle.raw, under_voltage_now: ($sys.cpu.throttle.underVoltage | b),
    ever_under_voltage: ($sys.cpu.throttle.everUnderVoltage | b), ever_throttled: ($sys.cpu.throttle.everThrottled | b),
    ever_freq_capped: ($sys.cpu.throttle.everFreqCapped | b), ever_soft_temp: ($sys.cpu.throttle.everSoftTempLimit | b),
    disk_pct: $sys.disk.usedPct, mem_pct: $sys.mem.usedPct, bytes_written: $sys.storage.bytesWritten,
    clock_synced: ($sys.clock.synced | b), last_sync_at: $sys.clock.lastSyncAt,
    clock_skew_s: (try (($sys.clock.now | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) - $now) catch null),
    tls_days: $tls,
    uplink: $up.status, uplink_valid_until: $up.validUntil,
    sport: $st.sport, build: $st.build, panel_connected: ($st.ledbox.connected | b), mode: $st.mode }')
if [ $DRY = 1 ]; then echo "would append to board.db: $ROW"; else db_row samples "$ROW"; fi

# ---------------------------------------------------------------------------------------------
# 3. alerts

if [ "$ONLINE" = true ]; then
  # back from an outage: one message (kept pending until ntfy took it), and the offline alert may
  # fire again the next time
  BACK_SENT=1
  if [ "$PREV_ONLINE" = false ] && [ -n "$PREV_SINCE" ] && [ $((NOW - PREV_SINCE)) -ge $((OFFLINE_H * 3600)) ]; then
    if post default white_check_mark "Scoreboard back online" \
      "$NODE is back on the tailnet after $(dur $((NOW - PREV_SINCE))) (offline since $(when "$PREV_SINCE")). Console on :$HTTP_PORT: $([ "$REACHABLE" = true ] && echo answering || echo NOT answering)." \
      back_online; then
      [ $DRY = 0 ] && st_set 'del(.alerted.offline_game)'
    else
      BACK_SENT=0
    fi
  fi
  [ $DRY = 0 ] && [ $BACK_SENT = 1 ] && st_set --argjson t "$NOW" '.node = {online: true, offline_since: null, online_seen_at: $t}'

  if [ "$REACHABLE" = false ]; then
    alert appliance_down high warning "Scoreboard online but console not answering" \
      "$NODE is on the tailnet but http :$HTTP_PORT did not answer (twice, 5 s apart: $([ "${PROBE_CODE:-000}" = 000 ] && echo "no connection" || echo "HTTP $PROBE_CODE")). The scoring console and the panel bridge run in ledbox-bridge: ssh ledbox 'systemctl status ledbox-bridge; journalctl -u ledbox-bridge -n 50'"
  fi

  if [ "$SYS" != null ]; then
    UV=$(jq -r '.cpu.throttle // {} | [ (if .underVoltage then "under-voltage right now" else empty end),
                                         (if .everUnderVoltage then "under-voltage has occurred since boot" else empty end) ] | join("; ")' <<<"$SYS")
    if [ -n "$UV" ]; then
      alert undervoltage high zap "Scoreboard under-voltage" \
        "get_throttled=$(jq -r '.cpu.throttle.raw' <<<"$SYS"): $UV (board up $(dur "$(jq -r '.host.uptimeSec // 0' <<<"$SYS")")). The Pi and the panel share one supply: check the PSU, the cable and the plug strip. The sticky bit only clears on a reboot."
    fi
    if jq -e --argjson max $DISK_PCT '(.disk.usedPct // 0) > $max' <<<"$SYS" >/dev/null; then
      alert disk default warning "Scoreboard disk $(jq -r '.disk.usedPct | floor' <<<"$SYS")% full" \
        "The board's root filesystem is $(jq -r '.disk.usedPct' <<<"$SYS") % used ($(jq -r '(.disk.freeBytes // 0) / 1048576 | floor' <<<"$SYS") MB free). Usual suspects: ssh ledbox 'df -h /; du -sh ~/ledbox-bridge/.deploy-backups ~/ledbox-bridge/data /var/log/journal'"
    fi
    if jq -e --argjson g $CLOCK_GRACE_S '.clock.synced == false and (.host.uptimeSec // 0) > $g' <<<"$SYS" >/dev/null; then
      alert clock default clock "Scoreboard clock not synced" \
        "systemd-timesyncd has not synced during this boot (board up $(dur "$(jq -r '.host.uptimeSec' <<<"$SYS")"), last sync $(jq -r '.clock.lastSyncAt // "never"' <<<"$SYS"), board clock off by $(jq -r '.clock_skew_s // "?"' <<<"$ROW") s). The board has no RTC and stamps the match history with this clock. Check: ssh ledbox 'timedatectl timesync-status'"
    fi
  fi
  if [ "$TLS" != null ] && [ "$TLS" -lt $TLS_DAYS ]; then
    alert tls default lock "Scoreboard TLS cert: $TLS days left" \
      "The console's https certificate on :$HTTPS_PORT expires $(date -d "$END" '+%a %d.%m.%Y %H:%M') ($TLS days). It is renewed on the board by ledbox-tls-renew.timer (tailscale cert): ssh ledbox 'systemctl status ledbox-tls-renew.timer; journalctl -u ledbox-tls-renew -n 30'"
  fi
else
  # LastSeen is the control plane's own record; the state file only fills in when it is missing
  OFF_FROM=${LS_EPOCH:-${PREV_SINCE:-$NOW}}
  [ $DRY = 0 ] && st_set --argjson t "$OFF_FROM" '.node = {online: false, offline_since: $t}'
  OFF_FOR=$((NOW - OFF_FROM))
  if [ $OFF_FOR -ge $((OFFLINE_H * 3600)) ]; then
    if GAMES=$(games_between $((NOW - 3600)) $((NOW + GAME_AHEAD_H * 3600))); then
      if [ -n "$GAMES" ]; then
        alert offline_game high rotating_light "Scoreboard offline - home game soon" \
          "$NODE has been off the tailnet for $(dur $OFF_FOR) (last seen $(when "$OFF_FROM")). Home games in the next $GAME_AHEAD_H h:
$(cut -f2 <<<"$GAMES" | head -5 | sed 's/^/- /')
Power the board on and check its hall uplink before the game."
      else
        echo "no home game in the next $GAME_AHEAD_H h — an idle board is fine, no alert"
      fi
    else
      alert offline_game high rotating_light "Scoreboard offline - schedule unknown" \
        "$NODE has been off the tailnet for $(dur $OFF_FOR) (last seen $(when "$OFF_FROM")). The games list ($DIRECTUS) could not be read, so this cannot tell whether a home game is coming up."
    fi
  fi
fi

# ---------------------------------------------------------------------------------------------
# 5. nightly log pull to the NAS

pull_logs() {
  local base="http://$IP:$HTTP_PORT" stats sa lid buffered maxe cur_sa cur_id cur_ts mode n name y size got last last_id last_ts
  stats=$(curl -fsS -m 20 "$base/api/logs?limit=1" | jq -c '.stats | select(type == "object")') || stats=''
  if [ -z "$stats" ]; then echo "log pull: GET /api/logs did not answer"; return 1; fi
  sa=$(jq -r '.startedAt // ""' <<<"$stats"); lid=$(jq -r '.lastId // 0' <<<"$stats")
  buffered=$(jq -r '.buffered // 0' <<<"$stats"); maxe=$(jq -r '.maxEntries // 2000' <<<"$stats")
  cur_sa=$(st '.logs.started_at'); cur_id=$(st '.logs.last_id'); cur_ts=$(st '.logs.last_ts')
  # ids restart at 1 with every board process; the ring holds the last $maxe entries
  if [ -n "$cur_sa" ] && [ "$sa" = "$cur_sa" ] && [ -n "$cur_id" ] && [ "$lid" -ge "$cur_id" ] && [ $((lid - buffered)) -le "$cur_id" ]; then
    mode=delta
    curl -fsS -m 120 --max-filesize $((16 * 1024 * 1024)) "$base/api/logs?sinceId=$cur_id&limit=$maxe" \
      | jq -c '.entries[]' >"$TMP/new.jsonl" || { echo "log pull: delta read failed"; return 1; }
  else
    mode=export
    curl -fsS -m 900 --max-filesize $((40 * 1024 * 1024)) "$base/api/logs/export" >"$TMP/all.jsonl" \
      || { echo "log pull: GET /api/logs/export failed"; return 1; }
    jq -c -R --arg t "$cur_ts" 'fromjson? | select(type == "object") | select($t == "" or ((.ts // "") > $t))' \
      "$TMP/all.jsonl" >"$TMP/new.jsonl"
  fi
  n=$(wc -l <"$TMP/new.jsonl")
  last=$(tail -n 1 "$TMP/new.jsonl")
  last_id=$cur_id last_ts=$cur_ts
  if [ -n "$last" ]; then last_id=$(jq -r '.id // 0' <<<"$last"); last_ts=$(jq -r '.ts // ""' <<<"$last"); fi
  # the newest line can belong to an earlier process (a fresh boot that has not logged yet)
  if [ $mode = export ] && [[ "$last_ts" < "$sa" ]]; then last_id=0; fi
  name='' size=0
  if [ "$n" -gt 0 ]; then
    y=$(date +%Y)
    name="$NODE-$(date +%Y%m%d-%H%M)-$mode.jsonl.gz"
    gzip -9c "$TMP/new.jsonl" >"$TMP/$name"
    size=$(stat -c %s "$TMP/$name")
    if ! ssh "${SSHO[@]}" "$NAS" "mkdir -p '$NAS_DIR/$y' && cat > '$NAS_DIR/$y/.$name.part' && mv -f '$NAS_DIR/$y/.$name.part' '$NAS_DIR/$y/$name'" <"$TMP/$name"; then
      echo "log pull: writing $NAS:$NAS_DIR/$y/$name failed"; return 1
    fi
    got=$(ssh -n "${SSHO[@]}" "$NAS" "stat -c %s '$NAS_DIR/$y/$name'" 2>/dev/null)
    if [ "$got" != "$size" ]; then echo "log pull: $name on the NAS is $got bytes, expected $size"; return 1; fi
    name="$y/$name"
  fi
  st_set --arg sa "$sa" --argjson id "${last_id:-0}" --arg ts "$last_ts" --arg d "$TODAY" --argjson t "$NOW" \
    '.logs = {started_at: $sa, last_id: $id, last_ts: $ts, last_pull_day: $d, last_pull_at: $t}'
  db_row log_pulls "$(jq -n -c --arg ts "$(date -u +%FT%TZ)" --arg m $mode --argjson n "$n" --argjson b "$size" --arg f "$name" \
    '{ts:$ts, mode:$m, lines:$n, bytes:$b, file:(if $f == "" then null else $f end), ok:1, note:null}')"
  echo "log pull ($mode): $n new line(s)${name:+ -> $NAS:$NAS_DIR/$name}"
}

LOG_WHY=''
LAST_PULL_DAY=$(st '.logs.last_pull_day')
LAST_PULL_AT=$(st '.logs.last_pull_at')
if [ $FORCE_LOGS = 1 ]; then LOG_WHY='asked for (--pull-logs)'
elif [ "$LAST_PULL_DAY" != "$TODAY" ]; then
  if [ $HOUR -ge 3 ] && [ $HOUR -lt 7 ]; then LOG_WHY='nightly'
  elif [ -z "$LAST_PULL_AT" ] || [ $((NOW - LAST_PULL_AT)) -ge $((44 * 3600)) ]; then LOG_WHY='catch-up (no pull for 44 h)'; fi
  # never around a match: a full export is up to ~15 MB over the hall's uplink
  if [ -n "$LOG_WHY" ] && [ "$REACHABLE" = true ] && near=$(games_between $((NOW - 3 * 3600)) $((NOW + 3 * 3600))) && [ -n "$near" ]; then
    echo "log pull: waiting — home game around now ($(head -1 <<<"$near" | cut -f2))"
    LOG_WHY=''
  fi
fi
if [ -n "$LOG_WHY" ]; then
  if [ "$REACHABLE" != true ]; then
    echo "log pull due ($LOG_WHY) — board not reachable, next run tries again"
  elif [ $DRY = 1 ]; then
    echo "log pull due ($LOG_WHY) — would pull the new lines to $NAS:$NAS_DIR/$(date +%Y)/"
  elif ! pull_logs; then
    db_row log_pulls "$(jq -n -c --arg ts "$(date -u +%FT%TZ)" '{ts:$ts, ok:0, note:"failed, see journal"}')"
    RC=1
  fi
fi

save_state
exit $RC
