#!/usr/bin/env bash
# Run BEFORE deploy-board.sh: is the board running anything this repo has never seen?
#
# deploy-board.sh copies src/*.js, web/ and the KSCW layouts over the board's copy without looking
# at what is there. On 2026-09-23 the board was running features that had never been committed
# (merged back in efd3ac5), and a plain deploy would have wiped them.
#
# Hashes every file the deploy overwrites as a git blob ON the board (the board has no git, so the
# blob header is built by hand), then looks each blob up anywhere in this repo's history. A known
# blob is just an older deploy. An unknown blob at a path the repo also has is a board-only edit
# the deploy would overwrite: it is listed, and the exit code is 1. Files the repo does not have
# at all (old index.html backups and the like) are listed too, but the deploy leaves them alone.
#
#   ./drift-check.sh                         # the board by SSH alias `ledbox`, like deploy-board.sh
#   BOARD=pi@172.24.1.1 ./drift-check.sh     # a laptop on the board's own AP, ledbox_C0270
#   BOARD=pi@192.168.5.1 JUMP=openvolley ./drift-check.sh
#
# Uses the repo's whole history, so run it from a full clone, not a shallow one.
set -euo pipefail

BOARD=${BOARD:-ledbox}
JUMP=${JUMP:-}
J=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
[ -n "$JUMP" ] && J+=(-J "$JUMP")

REPO="$(cd "$(dirname "$0")" && pwd)"

known=$(git -C "$REPO" rev-list --all --objects | cut -d' ' -f1)

# The same file set as deploy-board.sh step 3, with paths as they sit in the repo.
board=$(ssh "${J[@]}" "$BOARD" bash -s <<'EOF'
set -e
blob() { { printf 'blob %s\0' "$(stat -c%s "$1")"; cat "$1"; } | sha1sum | cut -c1-40; }
cd /home/pi/ledbox-bridge
for f in src/*.js $(find web -type f); do echo "$(blob "$f") $f"; done
for f in provisioning/*.sh provisioning/*.service provisioning/*.pem firmware/ledbox-watchdog.sh tools/*.mjs; do
  [ -f "$f" ] && echo "$(blob "$f") $f"
done
cd /home/pi/ledbox/layout
for f in *_kscw_*.xml *_beach_matchscore.xml *_basketball_matchscore.xml; do
  [ -f "$f" ] && echo "$(blob "$f") layouts/$f"
done
true
EOF
)

drift=0 same=0 older=0
while read -r h path; do
  [ -n "$h" ] || continue
  if [ "$h" = "$(git -C "$REPO" rev-parse -q --verify "HEAD:$path" 2>/dev/null)" ]; then
    same=$((same + 1))
  elif grep -qx "$h" <<<"$known"; then
    older=$((older + 1))
  elif git -C "$REPO" cat-file -e "HEAD:$path" 2>/dev/null; then
    echo "  BOARD-ONLY  $path  (the deploy would overwrite it)"; drift=1
  else
    echo "  extra       $path  (not in the repo; the deploy leaves it alone)"
  fi
done <<<"$board"

echo "  $same files already current, $older files from an older commit"
if [ "$drift" = 1 ]; then
  echo "!! STOP: the board has changes the repo never had. Copy them off and commit them before deploying."
  exit 1
fi
echo "OK: nothing on the board would be lost. Safe to deploy."
