#!/usr/bin/env bash
# Deploy the KSCW LedBox BRIDGE to the board.
#
# The board is reached by SSH alias, default `ledbox`. Put it in your ~/.ssh/config — deliberately
# NOT hardcoded here, because this repo is public and addresses do not belong in it:
#
#   Host ledbox
#     HostName <the board's tailnet address>
#     User pi
#
# This used to reach the board ONLY through the `openvolley` Pi as a jump host, over the
# 192.168.5.0/24 cable. That Pi is no longer a permanent fixture: the board has its own wifi uplink
# and its own tailnet node, and the cable is now a debug path rather than the deploy path. To
# deploy over the cable anyway — board off the wifi, or you are standing next to it — set both:
#
#   BOARD=pi@192.168.5.1 JUMP=openvolley ./deploy-board.sh
#
# From cold the board answers ~2 min after power-on, so a run started straight after switching it
# on can fail step 1 — wait rather than assume a fault.
#
# Ships the WHOLE of src/ and the WHOLE of web/. It used to name individual files, which meant
# every change had to remember to add itself to the list — and one that didn't (a fix living in
# ledboxClient.js) would deploy "successfully" while the actual fix never reached the board. The
# same trap caught web/ when logs.html arrived, so both are now synced wholesale.
#
# NOT shipped: the firmware's crest+QR idle screen (lives on the board's own disk and survives
# power cycles — see firmware/idle-crest-qr/), settings.json (the board's operator preferences)
# and data/ (its match history).
set -euo pipefail

BOARD=${BOARD:-ledbox}
JUMP=${JUMP:-}
J=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
[ -n "$JUMP" ] && J+=(-J "$JUMP")

REPO="$(cd "$(dirname "$0")" && pwd)"
DEST=/home/pi/ledbox-bridge
STAMP="$(date +%Y%m%d-%H%M%S)"
KEEP=5 # how many previous deploys to keep under .deploy-backups (see step 2)

echo "== 1) board reachable? =="
ssh "${J[@]}" "$BOARD" hostname || {
  echo "!! board not reachable as '$BOARD'${JUMP:+ via $JUMP} — powered on? tailnet up? (needs ~2 min from cold)"
  echo "   over the debug cable instead:  BOARD=pi@192.168.5.1 JUMP=openvolley $0"
  exit 1
}

echo "== 2) back up what is on the board now =="
# KEEP is a cap, not a suggestion: the board is a 6.8G SD card and this used to add a backup per
# deploy with nothing ever removing one. Timestamped names sort chronologically, so "all but the
# newest KEEP" is just a tail of the sorted list.
ssh "${J[@]}" "$BOARD" "B=$DEST/.deploy-backups/$STAMP
  mkdir -p \"\$B\"
  cp -a $DEST/src \"\$B/src\" 2>/dev/null || true
  cp -a $DEST/web \"\$B/web\" 2>/dev/null || true
  echo \"  backed up to \$B\"
  cd $DEST/.deploy-backups 2>/dev/null && ls -1d 20* 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -rf -- \"\$old\" && echo \"  pruned old backup \$old\"
  done
  true"

echo "== 3) copy bridge sources + control UI =="
scp "${J[@]}" "$REPO"/src/*.js "$BOARD:$DEST/src/"
scp "${J[@]}" "$REPO"/web/*.html "$BOARD:$DEST/web/"

echo "== 4) restart bridge =="
ssh "${J[@]}" "$BOARD" 'sudo systemctl restart ledbox-bridge'
sleep 6

echo "== 5) verify =="
# Every check contributes to a remote exit code. This block used to end each line in
# `grep -q ... && echo ok || echo MISSING`, which is always 0 — so a bridge in a crash loop, a
# failed status probe and every '✗ MISSING' all still printed "DONE." and exited clean.
set +e
ssh "${J[@]}" "$BOARD" "
  rc=0
  chk() { # chk <label> <ok-marker>  — reads the test's exit status from \$?
    if [ \"\$1\" = 0 ]; then echo \"  ✓ \$2\"; else echo \"  ✗ \$2 MISSING\"; rc=1; fi
  }
  echo -n '  bridge: '; systemctl is-active ledbox-bridge || rc=1
  N=/opt/nodejs/bin/node
  \$N -e 'fetch(\"http://127.0.0.1:8890/api/status\").then(r=>r.json()).then(s=>console.log(\"  connected=\"+(s.ledbox&&s.ledbox.connected),\"sport=\"+s.sport,\"pinRequired=\"+s.pinRequired)).catch(e=>{console.log(\"  status ERR\",e.message);process.exit(1)})' || rc=1
  # Prove the NEW code is what is actually running — not merely that something started.
  grep -q SELF-CLOCKED     $DEST/src/ledboxClient.js; chk \$? 'self-clocked blink'
  grep -q showSportConfirm $DEST/src/ledboxClient.js; chk \$? 'sport confirmation'
  grep -q sport-switch     $DEST/src/appliance.js;    chk \$? 'sport-switch marker'
  grep -q LAST_STATUS      $DEST/web/index.html;      chk \$? 'UI status-merge'
  test -f $DEST/web/logs.html;                        chk \$? '/logs viewer'
  grep -q logStore         $DEST/src/appliance.js;    chk \$? 'structured logging'
  exit \$rc"
VERIFY=$?
set -e

echo
if [ "$VERIFY" -ne 0 ]; then
  echo "!! DEPLOY VERIFY FAILED (exit $VERIFY) — the board may be running broken code. Roll back:"
else
  echo "DONE. Roll back with:"
fi
echo "  ssh ${JUMP:+-J $JUMP }$BOARD 'cp -a $DEST/.deploy-backups/$STAMP/src/. $DEST/src/ && cp -a $DEST/.deploy-backups/$STAMP/web/. $DEST/web/ && sudo systemctl restart ledbox-bridge'"
exit "$VERIFY"
