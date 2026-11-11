#!/usr/bin/env bash
# Build OpenVolley's web app + LAN relay for the C0270 board, from an OpenVolley release tag.
#
#   tools/build-openvolley-web.sh 3.0.20            # tag desktop-v3.0.20
#   OPENVOLLEY_REPO=~/repos/openvolley tools/build-openvolley-web.sh 3.0.20
#
# Writes dist-openvolley/openvolley-web-<version>.tar.gz (gitignored); deploy-board.sh ships it.
#
# The board then serves OpenVolley itself (docs/openvolley-link-DESIGN.md): a tablet or phone opens
# http://172.24.1.1:5173 in a browser, or points the Android app at 172.24.1.1, and scores against
# the board's own relay, with no laptop and no internet. Link mode follows it on ws://127.0.0.1:8080.
#
# What goes in the bundle is exactly what OpenVolley's own frontend/server.js needs to run (the
# desktop app's Node relay): server.js, lanRelayCore.js, the two .cjs cores it imports, the built
# dist/ and the `ws` package. Nothing in OpenVolley is changed.
#
# Built from `git archive` of the tag, never from a working tree: a checkout's .env files would end
# up in the build (a VITE_BACKEND_URL there sends the scorer's relay to the cloud instead of to the
# board), and uncommitted edits would ship as if they were the release. Like the desktop app's CI
# build (desktop.yml), no VITE_* is set.
set -euo pipefail

VER=${1:?usage: $0 <openvolley version, e.g. 3.0.20>}
VER=${VER#desktop-v}
VER=${VER#v}
TAG="desktop-v$VER"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OV=${OPENVOLLEY_REPO:-$REPO/../openvolley}
OUT="$REPO/dist-openvolley"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "== 1) tag $TAG from $OV =="
git -C "$OV" fetch -q origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || true
git -C "$OV" rev-parse -q --verify "refs/tags/$TAG^{commit}" >/dev/null || { echo "!! no tag $TAG in $OV"; exit 1; }
COMMIT=$(git -C "$OV" rev-parse "refs/tags/$TAG^{commit}")
git -C "$OV" archive "$TAG" escoresheet/frontend | tar -x -C "$WORK"
FE="$WORK/escoresheet/frontend"
APPVER=$(node -p "require('$FE/package.json').version")
[ "$APPVER" = "$VER" ] || { echo "!! $TAG's package.json says $APPVER"; exit 1; }

echo "== 2) npm ci + vite build (a few minutes) =="
(
  cd "$FE"
  # Only what is in the tag: no VITE_* from this shell either.
  for v in $(env | sed -n 's/^\(VITE_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
  npm ci --no-audit --no-fund --loglevel=error
  rm -rf node_modules/canvas # as desktop.yml: a native module the build does not need
  NODE_OPTIONS=--max-old-space-size=4096 npm run build --silent
)

echo "== 3) bundle =="
B="$WORK/openvolley-web-$VER"
mkdir -p "$B/electron" "$B/node_modules"
cp "$FE/server.js" "$FE/lanRelayCore.js" "$B/"
cp "$FE/electron/lanRelayCore.cjs" "$FE/electron/signSessionCore.cjs" "$B/electron/"
cp -a "$FE/dist" "$B/dist"
cp -a "$FE/node_modules/ws" "$B/node_modules/ws"
# server.js is ESM; the bundle's own package.json says so and nothing else.
printf '{ "name": "openvolley-web", "version": "%s", "private": true, "type": "module" }\n' "$VER" > "$B/package.json"
printf '{ "version": "%s", "tag": "%s", "commit": "%s", "built": "%s" }\n' \
  "$VER" "$TAG" "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$B/BUILD.json"
# Every relative import server.js and lanRelayCore.js make must be in the bundle.
for f in server.js lanRelayCore.js; do
  for imp in $(sed -n "s/^import .* from '\(\.[^']*\)'.*/\1/p" "$B/$f"); do
    [ -f "$B/$imp" ] || { echo "!! $f imports $imp, not in the bundle"; exit 1; }
  done
done

echo "== 4) smoke test: the bundle serves the app and the relay =="
PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
WSP=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
(cd "$B" && env -u NODE_ENV -u USE_HTTPS PORT="$PORT" WS_PORT="$WSP" HTTPS=false HOSTNAME=127.0.0.1 node server.js >"$WORK/smoke.log" 2>&1) &
PID=$!
up=
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && { up=1; break; }; sleep 0.2; done
rc=0
if [ -z "$up" ]; then echo "!! did not come up:"; cat "$WORK/smoke.log"; rc=1; else
  curl -fsS "http://127.0.0.1:$PORT/api/server/status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.running||String(j.wsPort)!==process.argv[1])process.exit(1);console.log("  status: running, wsPort "+j.wsPort)})' "$WSP" || rc=1
  for p in / /referee /bench /livescore; do
    curl -fsS "http://127.0.0.1:$PORT$p" | grep -qi '<div id="root"' && echo "  $p ok" || { echo "!! $p"; rc=1; }
  done
fi
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
[ "$rc" = 0 ] || exit 1

mkdir -p "$OUT"
tar -C "$WORK" -czf "$OUT/openvolley-web-$VER.tar.gz" "openvolley-web-$VER"
echo "DONE: $OUT/openvolley-web-$VER.tar.gz ($(du -h "$OUT/openvolley-web-$VER.tar.gz" | cut -f1), $TAG $COMMIT)"
