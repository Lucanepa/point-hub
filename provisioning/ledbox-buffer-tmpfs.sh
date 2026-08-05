#!/bin/bash
# Keep the LED panel's frame buffers in RAM instead of on the SD card.
#
# WHY
# ---
# The vendor's renderer writes every frame to the card, twice:
#
#     LEDMatrix2.py:44   buffer.save('www/buffer.png')
#     LEDMatrix2.py:46   buffer_compressed.save('www/buffer_compressed.png', quality=95)
#
# and flushBuffer2 reads buffer.png back at ~62 fps to clock it out over GPIO. Measured on this
# board at idle, that is ~4.6 MB/min — about 6.4 GB/day if it is left powered, and it was left
# powered continuously from the day it went into service.
#
# The card is an SD16G with a Phison controller, dated 10/2019. Small rewrite-in-place files are
# the worst possible shape of workload for SD flash: a 7 KB overwrite can cost a whole erase
# block, so the wear is far larger than the byte count suggests. Nothing here is worth persisting
# — both files are regenerated on the very next frame — so they have no business being on the
# card at all.
#
# HOW
# ---
# A bind mount of a file in /run (already a tmpfs) over each of the two paths. Deliberately NOT a
# symlink: a bind mount changes NOTHING on the SD card, so `stop` restores the original state
# exactly, and a vendor firmware update cannot quietly leave a dangling link behind.
#
# WHAT WAS CHECKED FIRST
# ----------------------
#   * Nothing unlinks these files. A bind-mounted file cannot be removed (EBUSY), so an
#     os.remove() on either path would have broken the vendor app rather than the mount. The only
#     os.remove() calls in their tree are for layouts, uploads and their own logs.
#   * bin/startled, bin/startledbox and bin/stopledbox all `cp` onto buffer.png. cp opens the
#     destination O_WRONLY|O_TRUNC — it does not unlink — so the mount survives a restart.
#   * bin/watchdog treats buffer.png's MTIME as the "is the app still painting?" signal and
#     restarts the app if it goes stale. Writes to a tmpfs file update mtime exactly as on disk,
#     so the watchdog is unaffected. This is the one that would have been ugly to discover late.
#
# FAILING SAFE
# ------------
# If anything here does not work, the mounts simply are not there and the vendor app writes to
# the card exactly as it always did. The unit is ordered Before=rc-local.service but nothing
# Requires it, so a failure cannot stop the scoreboard from starting.
#
# Usage:
#   ledbox-buffer-tmpfs start     # seed from the card, then bind-mount
#   ledbox-buffer-tmpfs stop      # unmount, back to writing on the card
#   ledbox-buffer-tmpfs status    # what is mounted right now
set -uo pipefail

WWW=${LEDBOX_WWW:-/home/pi/ledbox/www}
RAM=${LEDBOX_BUF_RAM:-/run/ledbox-buffer}
FILES=(buffer.png buffer_compressed.png)

say() { printf '%s\n' "$*"; }

start() {
  mkdir -p "$RAM" || { say "cannot create $RAM"; return 1; }
  local f src rc=0
  for f in "${FILES[@]}"; do
    src="$WWW/$f"
    if [ ! -e "$src" ]; then say "  skip $f — not present"; continue; fi
    if mountpoint -q "$src"; then say "  $f already in RAM"; continue; fi
    # Seed from whatever is on the card. flushBuffer2 re-reads buffer.png continuously, and an
    # empty or half-written file is a panel full of garbage — so the RAM copy must be a complete
    # image from the instant the mount appears, not a zero-byte placeholder.
    #
    # -a to carry owner and mode across: the vendor app writes these as `pi`, and both
    # bin/startledbox and bin/stopledbox `cp` onto buffer.png as root.
    if ! cp -a "$src" "$RAM/$f"; then say "  cannot seed $f"; rc=1; continue; fi
    if mount --bind "$RAM/$f" "$src"; then say "  $f → RAM"; else say "  mount failed for $f"; rc=1; fi
  done
  return $rc
}

stop() {
  local f src rc=0
  for f in "${FILES[@]}"; do
    src="$WWW/$f"
    if mountpoint -q "$src"; then
      # Stash the current frame so the file left on the card is a real image rather than whatever
      # stale one happened to be there when the mount went up. Written NEXT to the mount point,
      # because $src itself is the mount and cannot be written through to the card until after
      # the umount.
      cp -a "$RAM/$f" "$src.restore" 2>/dev/null || :
      if umount "$src"; then
        # `cat >` rather than `mv`: the card's own file must keep its inode, owner and mode —
        # the vendor's scripts cp onto it as root while the app writes it as pi.
        [ -f "$src.restore" ] && cat "$src.restore" > "$src" 2>/dev/null
        rm -f "$src.restore"
        say "  $f → card"
      else
        say "  umount failed for $f (is something reading it?)"; rm -f "$src.restore"; rc=1
      fi
    else
      say "  $f was not in RAM"
    fi
  done
  return $rc
}

status() {
  local f src mounted=0
  for f in "${FILES[@]}"; do
    src="$WWW/$f"
    if mountpoint -q "$src"; then
      say "  $f: RAM   ($(stat -c%s "$src" 2>/dev/null) bytes, modified $(stat -c%y "$src" 2>/dev/null | cut -d. -f1))"
      mounted=$((mounted + 1))
    else
      say "  $f: CARD  ($(stat -c%s "$src" 2>/dev/null) bytes)"
    fi
  done
  say ""
  say "  writes to the card since boot: $(awk '/ mmcblk0 /{printf "%d MB", $10*512/1024/1024}' /proc/diskstats 2>/dev/null)"
  [ "$mounted" -eq "${#FILES[@]}" ] && return 0 || return 1
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) say "usage: $0 {start|stop|status}"; exit 2 ;;
esac
