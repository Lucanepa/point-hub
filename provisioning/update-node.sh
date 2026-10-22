#!/bin/bash
# Update the board's Node.js runtime: install /opt/nodejs-<ver>, flip /opt/nodejs to it, restart the
# bridge, and flip back by itself if the bridge does not come up healthy on the new one.
#
# The board ships an ancient distro Node, so the bridge runs a tarball install: /opt/nodejs is a
# SYMLINK to a versioned directory (systemd/ledbox-bridge.service), and /usr/local/bin/node points at
# /opt/nodejs/bin/node. An upgrade is therefore one atomic symlink flip with the old version still on
# disk, and so is the rollback.
#
# Version: 22.23.4, released 2026-10-20 — the newest v22 with a linux-armv7l tarball on nodejs.org
# (checked 2026-10-22 against https://nodejs.org/dist/index.json; SHASUMS256.txt below). The board's
# USERLAND is armhf on an arm64 kernel (firmware/RECOVERY.md), so it is armv7l whatever `uname -m`
# says. There is no armv7l Node 24 anywhere, and Node 22 ends 2027-04-30 (research system-07): the
# way past that is a 64-bit userland at the openscore cutover, not this script.
#
# The tarball: VERSION's pinned sha256 is checked whatever the source. Source, first found wins:
#   TARBALL=/path/node-v22.23.4-linux-armv7l.tar.xz   staged by hand (no internet in the hall)
#   ./node-v<ver>-linux-armv7l.tar.xz next to this script
#   a download from nodejs.org (needs the board's uplink)
# Stage it from lenovoserver when the board has no internet:
#   curl -fLO https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-armv7l.tar.xz
#   scp node-v22.23.4-linux-armv7l.tar.xz ledbox:ledbox-bridge/provisioning/
#
# Needs ~200 MB free on /opt (176 MB unpacked). Restarting the bridge does not blank the panel —
# the driver is separate — but do it with no match on.
#
#   sudo bash ledbox-bridge/provisioning/update-node.sh            # --check: what is installed, read-only
#   sudo bash ledbox-bridge/provisioning/update-node.sh --apply    # install + flip + verify (+ auto flip-back)
#   sudo bash ledbox-bridge/provisioning/update-node.sh --rollback # flip back to the version before
# VERSION=22.x.y SHA256=<sha256 of node-v22.x.y-linux-armv7l.tar.xz> for another version.
set -uo pipefail

VERSION=${VERSION:-22.23.4}
PINNED_VERSION=22.23.4
PINNED_SHA256=c9057c6a3b8fbb9651ed115c1e96d4a7281b7b9c9ca89fa05865c98ed7ffd437   # node-v22.23.4-linux-armv7l.tar.xz
if [ "$VERSION" = "$PINNED_VERSION" ]; then SHA256=${SHA256:-$PINNED_SHA256}; else SHA256=${SHA256:-}; fi
LINK=/opt/nodejs
PREV=/opt/nodejs.previous      # holds the directory the link pointed at before the last flip
DEST=/home/pi/ledbox-bridge
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
TGZ="node-v$VERSION-linux-armv7l.tar.xz"
URL="https://nodejs.org/dist/v$VERSION/$TGZ"
MODE=${1:---check}

case "$MODE" in --check|--apply|--rollback) ;; *) sed -n '2,32p' "$0"; exit 2 ;; esac
[ "$(id -u)" = 0 ] || { echo "!! must run as root — try: sudo bash $0 $MODE"; exit 1; }

say() { printf '\n=== %s ===\n' "$*"; }
current() { readlink -f "$LINK" 2>/dev/null; }

# Healthy = the unit is active, the process is the node we expect, and /api/status answers.
verify_bridge() { # $1 = expected node directory
  local i pid exe
  for i in $(seq 20); do
    sleep 1
    systemctl is-active --quiet ledbox-bridge || continue
    pid=$(systemctl show -p MainPID --value ledbox-bridge)
    exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null)
    [ "$exe" = "$1/bin/node" ] || continue
    if "$1/bin/node" -e 'fetch("http://127.0.0.1:8890/api/status",{signal:AbortSignal.timeout(3000)}).then(r=>r.json()).then(s=>{console.log("  bridge on "+process.version+": connected="+(s.ledbox&&s.ledbox.connected)+" sport="+s.sport);process.exit(0)}).catch(()=>process.exit(1))' 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

flip() { # atomic: a new link renamed over the old one, never a moment without /opt/nodejs
  ln -sfn "$1" "$LINK.next" && mv -Tf "$LINK.next" "$LINK"
}

case "$MODE" in
  --check)
    say "Node on the board"
    echo "  $LINK -> $(current)   ($("$LINK/bin/node" -v 2>/dev/null || echo 'no node there'))"
    echo "  /usr/local/bin/node -> $(readlink -f /usr/local/bin/node 2>/dev/null || echo absent)"
    echo "  bridge runs: $(readlink -f /proc/"$(systemctl show -p MainPID --value ledbox-bridge)"/exe 2>/dev/null || echo '?')"
    echo "  installed: $(ls -1d /opt/nodejs-* 2>/dev/null | tr '\n' ' ')"
    [ -f "$PREV" ] && echo "  previous (rollback target): $(cat "$PREV")"
    echo "  userland: $(dpkg --print-architecture 2>/dev/null) (kernel $(uname -m)), free on /opt: $(df -Pm /opt | awk 'NR==2{print $4}') MB"
    echo "  target: v$VERSION ($TGZ)"
    exit 0 ;;

  --rollback)
    say "rollback"
    [ -f "$PREV" ] || { echo "  !! no $PREV — nothing recorded to go back to"; exit 1; }
    back=$(cat "$PREV"); now=$(current)
    [ -x "$back/bin/node" ] || { echo "  !! $back/bin/node is missing"; exit 1; }
    flip "$back" || { echo "  !! flip failed"; exit 1; }
    echo "$now" > "$PREV"
    systemctl restart ledbox-bridge
    if verify_bridge "$back"; then echo "  back on $("$back/bin/node" -v) ($back); $now is still on disk"; exit 0; fi
    echo "  !! the bridge is not healthy on $back either — look at: journalctl -u ledbox-bridge -n 50"; exit 1 ;;
esac

# ── --apply ─────────────────────────────────────────────────────────────────────────────────────
say "preflight"
[ "$(dpkg --print-architecture 2>/dev/null)" = armhf ] || { echo "  !! userland is $(dpkg --print-architecture 2>/dev/null), not armhf — this tarball is armv7l"; exit 1; }
[ -n "$SHA256" ] || { echo "  !! VERSION=$VERSION is not the pinned one: pass SHA256=<from https://nodejs.org/dist/v$VERSION/SHASUMS256.txt>"; exit 1; }
OLD=$(current)
NEW=/opt/nodejs-$VERSION
echo "  now: $OLD ($("$LINK/bin/node" -v 2>/dev/null)), target: $NEW"
if [ "$OLD" = "$NEW" ]; then echo "  already on v$VERSION — nothing to do"; exit 0; fi

if [ -x "$NEW/bin/node" ] && [ "$("$NEW/bin/node" -v 2>/dev/null)" = "v$VERSION" ]; then
  echo "  $NEW already unpacked (from an earlier run)"
else
  [ "$(df -Pm /opt | awk 'NR==2{print $4}')" -ge 250 ] || { echo "  !! less than 250 MB free on /opt"; exit 1; }
  SRC=""
  for c in "${TARBALL:-}" "$HERE/$TGZ"; do [ -n "$c" ] && [ -f "$c" ] && { SRC=$c; break; }; done
  if [ -z "$SRC" ]; then
    SRC=/var/tmp/$TGZ
    echo "  downloading $URL"
    curl -fsSL --retry 2 -o "$SRC.part" "$URL" && mv -f "$SRC.part" "$SRC" \
      || { rm -f "$SRC.part"; echo "  !! download failed — no uplink? stage it: TARBALL=/path/$TGZ (see the header)"; exit 1; }
  fi
  echo "  tarball: $SRC"
  echo "$SHA256  $SRC" | sha256sum -c --quiet - 2>/dev/null \
    || { echo "  !! sha256 of $SRC is $(sha256sum "$SRC" | cut -d' ' -f1), expected $SHA256 — refusing"; exit 1; }
  echo "  sha256 OK"
  rm -rf "$NEW.partial" && mkdir -p "$NEW.partial" \
    && tar -xJf "$SRC" -C "$NEW.partial" --strip-components=1 --no-same-owner \
    || { rm -rf "$NEW.partial"; echo "  !! unpacking failed"; exit 1; }
  rm -rf "$NEW" && mv "$NEW.partial" "$NEW" || { echo "  !! could not move $NEW.partial into place"; exit 1; }
  echo "  unpacked to $NEW"
fi

say "smoke test, before anything points at it"
"$NEW/bin/node" -v >/dev/null 2>&1 || { echo "  !! $NEW/bin/node does not run on this board"; exit 1; }
# The bridge's own protocol codec, on the new runtime: gzip round trip + zlib.crc32 (Node >= 22.2).
( cd "$DEST" && "$NEW/bin/node" --input-type=module -e "import('./src/ledboxProtocol.js').then(m=>{const o=m.decode(m.encode({cmd:'x',value:[1]}));if(o.cmd!=='x')throw 0;import('node:zlib').then(z=>{if(typeof z.crc32!=='function')throw 0;console.log('  '+process.version+': codec OK')})}).catch(()=>process.exit(1))" ) \
  || { echo "  !! the bridge's code does not load on $NEW — not switching"; exit 1; }

say "flip $LINK → $NEW and restart the bridge"
echo "$OLD" > "$PREV"
flip "$NEW" || { echo "  !! flip failed — still on $OLD"; exit 1; }
echo "  $LINK -> $(current)"
[ "$(readlink -f /usr/local/bin/node 2>/dev/null)" = "$NEW/bin/node" ] \
  || echo "  note: /usr/local/bin/node -> $(readlink -f /usr/local/bin/node 2>/dev/null || echo absent), not through $LINK — the shell may still run another node"
systemctl restart ledbox-bridge
if verify_bridge "$NEW"; then
  echo "  OK: the bridge runs $("$NEW/bin/node" -v). $OLD stays on disk; undo: --rollback"
  exit 0
fi
echo "  !! the bridge is NOT healthy on $NEW within 20 s — flipping back to $OLD"
journalctl -u ledbox-bridge -n 12 --no-pager 2>/dev/null | sed 's/^/     /'
flip "$OLD" && systemctl restart ledbox-bridge
if verify_bridge "$OLD"; then echo "  back on $OLD — healthy"; else echo "  !! not healthy on $OLD either — journalctl -u ledbox-bridge"; fi
exit 1
