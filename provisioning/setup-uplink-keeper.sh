#!/bin/bash
# The uplink keeper: wlan1 converges on the best saved Wi-Fi in range by itself — lockout-safe for
# the school login. The logic, and every reason behind it, is in src/uplinkKeeper.js.
#
# Why: NetworkManager joins the best network it sees at the moment it connects and then stays. It
# never leaves a working (or a captive, offline) connection for a better one that shows up later,
# and a profile it failed once is blocked until the next reboot. On 17.11.2026 the C0270 came up at
# the KWI hall on Free_WLAN_KTZH, behind its SMS login page and so offline, with SCHULEN_KTZH in
# range — nobody could reach it. Plug and play means the board fixes that itself.
#
# What --apply installs (all root-owned; the bridge, running as pi, only reads the state files):
#   /usr/local/lib/ledbox/uplink-keeper.mjs    a COPY of src/uplinkKeeper.js — root must not run
#                                              code the bridge's user can rewrite
#   /usr/local/sbin/ledbox-uplink-keeper       the loop: one look 45 s after boot, then every 2 min
#   /etc/systemd/system/ledbox-uplink-keeper.service   enabled, Restart=always
#   /var/lib/ledbox-uplink/keeper.json         attempts and refusals (survive a reboot), 0644
#   /run/ledbox-uplink/status.json             what the last look saw (tmpfs), 0644
# A loop, not a timer, like ledbox-bridge-probe (setup-supervision.sh): a 2-minute timer logs
# "Starting/Finished" 1440 times a day into a journal on the SD card. The keeper logs only when it
# acts.
#
# And it takes over the school login's attempts: every 802.1X profile on wlan1 (hall-login) gets
# NM autoconnect OFF, and the keeper brings it up — at most 4 attempts that did not connect in any
# 24 h, with backoff, and never again after one refusal until setup-wlan1-client.sh --login has been
# run with the right password (it resets the keeper when that login works) or --reset below. NM's
# own autoconnect would present a changed password at every boot (~2 strikes each) where no cap
# could see it. --rollback gives hall-login its autoconnect back unless the keeper had seen it refused.
#
# NOT run by deploy-board.sh, which only ships it. On the board, from the bridge install:
#
#   sudo bash ledbox-bridge/provisioning/setup-uplink-keeper.sh              # --check: read-only
#   sudo bash ledbox-bridge/provisioning/setup-uplink-keeper.sh --apply      # install / update
#   sudo bash ledbox-bridge/provisioning/setup-uplink-keeper.sh --rollback   # undo the last --apply
#   sudo bash ledbox-bridge/provisioning/setup-uplink-keeper.sh --reset [hall-login]
#                         # let a refused or capped school login be tried again (after fixing why)
#
# Re-run --apply after a deploy that changed src/uplinkKeeper.js: the installed copy is not updated
# by a deploy (deploy-board.sh's verify step says when the two differ).
set -uo pipefail

LP_NAME=setup-uplink-keeper
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
. "$HERE/lib-provision.sh" || { echo "!! lib-provision.sh missing next to $0"; exit 1; }

MODE=${1:---check}
case "$MODE" in --check|--apply|--rollback|--reset) ;; *) sed -n '2,40p' "$0"; exit 2 ;; esac
lp_need_root "$MODE"

SRC=${KEEPER_SRC:-$HERE/../src/uplinkKeeper.js}   # in a checkout, and where deploy ships it
LIB=/usr/local/lib/ledbox/uplink-keeper.mjs
BIN=/usr/local/sbin/ledbox-uplink-keeper
UNIT=/etc/systemd/system/ledbox-uplink-keeper.service
WANTS=/etc/systemd/system/multi-user.target.wants/ledbox-uplink-keeper.service
STATE=/var/lib/ledbox-uplink/keeper.json
NODE=/opt/nodejs/bin/node
[ -x "$NODE" ] || NODE=$(command -v node 2>/dev/null || echo /opt/nodejs/bin/node)

RC=0
fail() { echo "  !! $*"; RC=1; }

# The 802.1X profiles on wlan1 (hall-login, normally), one per line.
eap_profiles() {
  local n
  nmcli -t -e no -f TYPE,NAME connection show 2>/dev/null | sed -n 's/^802-11-wireless://p' | while IFS= read -r n; do
    [ "$(nmcli -g 802-11-wireless-security.key-mgmt connection show id "$n" 2>/dev/null)" = wpa-eap ] || continue
    case "$(nmcli -g connection.interface-name connection show id "$n" 2>/dev/null)" in wlan1|"") printf '%s\n' "$n" ;; esac
  done
}

check() {
  say "uplink keeper"
  if [ -x "$NODE" ]; then echo "  node: $NODE ($("$NODE" --version 2>/dev/null))"; else echo "  !! no node at /opt/nodejs/bin/node or on PATH — the keeper cannot run"; fi
  if [ -f "$UNIT" ]; then
    echo "  ledbox-uplink-keeper: $(systemctl is-enabled ledbox-uplink-keeper 2>/dev/null) / $(systemctl is-active ledbox-uplink-keeper 2>/dev/null)"
  else
    echo "  not installed (--apply installs it)"
  fi
  if [ -f "$LIB" ] && [ -f "$SRC" ]; then
    cmp -s "$LIB" "$SRC" && echo "  installed copy = this checkout's src/uplinkKeeper.js" \
      || echo "  !! the installed copy DIFFERS from $SRC — --apply updates it"
  elif [ ! -f "$SRC" ]; then
    echo "  (no $SRC to compare against — deploy-board.sh ships it)"
  fi
  local n
  for n in $(eap_profiles); do
    echo "  802.1X profile '$n': NM autoconnect $(nmcli -g connection.autoconnect connection show id "$n" 2>/dev/null) (the keeper wants 'no' — it brings it up itself)"
  done
  if [ -f "$LIB" ] && [ -x "$NODE" ]; then
    echo "  what it last did (keeper --status):"
    "$NODE" "$LIB" --status 2>&1 | sed 's/^/    /'
    echo "  what it would do now (keeper --dry-run, changes nothing):"
    "$NODE" "$LIB" --dry-run 2>&1 | sed 's/^/    /'
  fi
  journalctl -t ledbox-uplink-keeper -n 8 --no-pager 2>/dev/null | sed 's/^/  log: /'
}

apply() {
  say "uplink keeper — install"
  [ -f "$SRC" ] || { fail "no $SRC — run this from the bridge install deploy-board.sh keeps current"; return; }
  [ -x "$NODE" ] || { fail "no node at /opt/nodejs/bin/node or on PATH"; return; }
  # A syntax check of the very file root is about to run every two minutes.
  "$NODE" --check "$SRC" 2>/dev/null || "$NODE" -e "import('file://$SRC')" >/dev/null 2>&1 \
    || { fail "$SRC does not load with $NODE — not installing it"; return; }
  local a b c
  lp_put "$LIB" 0644 < "$SRC"; a=$?
  lp_put "$BIN" 0755 <<EOF
#!/bin/bash
# Installed by point-hub provisioning/setup-uplink-keeper.sh — the uplink keeper's loop. One look
# 45 s after boot (NM has joined whatever it found first by then), then one every 2 minutes, never
# two at once: the next starts only after the last has finished, attempt and all.
NODE=$NODE
[ -x "\$NODE" ] || NODE=\$(command -v node)
sleep 45
while :; do
  "\$NODE" $LIB --once
  sleep 120
done
EOF
  b=$?
  lp_put "$UNIT" 0644 <<'EOF'
# Installed by point-hub provisioning/setup-uplink-keeper.sh. Keeps wlan1 on the best saved Wi-Fi in
# range; lockout-safe for the school login (src/uplinkKeeper.js). A loop, not a timer — see there.
[Unit]
Description=LedBox: keep wlan1 on the best saved Wi-Fi in range (lockout-safe for the school login)
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=simple
ExecStart=/usr/local/sbin/ledbox-uplink-keeper
Restart=always
RestartSec=30
SyslogIdentifier=ledbox-uplink-keeper

[Install]
WantedBy=multi-user.target
EOF
  c=$?
  { [ "$a" = 1 ] || [ "$b" = 1 ] || [ "$c" = 1 ]; } && { fail "could not install the keeper"; return; }
  # The state directory: root writes, the bridge (pi) reads. Nothing secret goes in it.
  install -d -o root -g root -m 0755 /var/lib/ledbox-uplink || { fail "could not create /var/lib/ledbox-uplink"; return; }
  lp_bak "$WANTS" || { fail "backup failed"; return; }
  systemctl daemon-reload
  systemctl enable ledbox-uplink-keeper >/dev/null 2>&1 || { fail "could not enable ledbox-uplink-keeper"; return; }
  if [ "$a" = 0 ] || [ "$b" = 0 ] || [ "$c" = 0 ]; then systemctl restart ledbox-uplink-keeper; else systemctl start ledbox-uplink-keeper; fi \
    || { fail "could not start ledbox-uplink-keeper"; return; }
  # The school login's attempts are the keeper's from now on (the keeper does this itself on every
  # look as well; doing it here means it holds from this moment, not from the first look).
  local n
  for n in $(eap_profiles); do
    if [ "$(nmcli -g connection.autoconnect connection show id "$n" 2>/dev/null)" = yes ]; then
      nmcli connection modify id "$n" connection.autoconnect no >/dev/null 2>&1 \
        && echo "  '$n' (802.1X): NM autoconnect off — the keeper brings it up, at most 4 tries a day, never after a refusal" \
        || fail "could not switch off autoconnect on '$n'"
    fi
  done
  echo "  ledbox-uplink-keeper: $(systemctl is-enabled ledbox-uplink-keeper) / $(systemctl is-active ledbox-uplink-keeper) — first look 45 s after it starts"
  echo "  watch it:  journalctl -t ledbox-uplink-keeper -f      what it would do:  sudo $NODE $LIB --dry-run"
}

rollback() {
  say "rollback — the newest $LP_NAME run"
  local run
  run=$(ls -1d "$LP_BACKUPS/$LP_NAME"-2* 2>/dev/null | grep -v '\.rolled-back$' | sort | tail -1)
  if [ -n "$run" ] && grep -qxF "$UNIT" "$run/ABSENT" 2>/dev/null; then systemctl disable --now ledbox-uplink-keeper >/dev/null 2>&1; fi
  # Before the files go: whether the keeper saw a refusal, so a refused login is not handed back to
  # NM's autoconnect (which would present it at every boot).
  local refused=""
  [ -f "$LIB" ] && [ -x "$NODE" ] && refused=$("$NODE" -e "
    const s = JSON.parse(require('fs').readFileSync('$STATE', 'utf8')); console.log(Object.keys(s.refused || {}).join(' '))" 2>/dev/null)
  lp_restore || RC=1
  systemctl daemon-reload
  if [ ! -f "$UNIT" ]; then
    local n
    for n in $(eap_profiles); do
      case " $refused " in
        *" $n "*) echo "  '$n' stays autoconnect OFF: the keeper saw its login refused — run setup-wlan1-client.sh --login" ;;
        *) nmcli connection modify id "$n" connection.autoconnect yes >/dev/null 2>&1 && echo "  '$n': NM autoconnect back on" ;;
      esac
    done
    echo "  (the state in /var/lib/ledbox-uplink is left as it was; delete it by hand if wanted)"
  fi
}

reset() {
  say "uplink keeper — reset ${1:-every 802.1X profile}"
  [ -f "$LIB" ] || { echo "  not installed — nothing to reset"; return; }
  "$NODE" "$LIB" --reset ${1:+"$1"} | sed 's/^/  /' || fail "reset failed"
}

case "$MODE" in
  --check) check ;;
  --apply)
    apply
    if [ -n "$LP_RUN" ]; then echo; echo "  backups of everything changed: $LP_RUN   (undo: --rollback)"
    else echo; echo "  nothing needed changing"; fi ;;
  --rollback) rollback ;;
  --reset) reset "${2:-}" ;;
esac

[ "$RC" = 0 ] || { echo; echo "!! one or more steps FAILED (see !! above)"; }
exit "$RC"
