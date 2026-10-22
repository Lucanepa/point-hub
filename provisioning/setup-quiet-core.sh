#!/bin/bash
# Give the LED panel's refresh thread a quiet CPU core, and keep the on-board audio from ever
# coming back.
#
# hzeller's library (inside flushBuffer2) already runs its refresh thread at real-time priority 99
# pinned to CPU 3 (led-matrix.cc:514). That keeps normal tasks off it, but not interrupts, softirqs
# or the timer tick — and this Pi 4 takes plenty: the USB Wi-Fi client (MT7612U), the AP, Node
# with TLS, tailscaled. Those delay rows, which shows as brightness ripple and refresh dips, to the
# eye and on camera. Upstream's own recommendation, verbatim, on the kernel command line:
#
#     isolcpus=domain,managed_irq,3 nohz_full=3 rcu_nocbs=3 irqaffinity=0,1,2
#
# nohz_full/rcu_nocbs are simply ignored by a kernel built without them, which is harmless. Three
# cores remain for everything else, which is plenty on a Pi 4. Then pick --led-limit-refresh just
# below the minimum --led-show-refresh reports (docs/onsite-2026-10-23.md), so the rate holds.
#
# AUDIO. With hardware pulsing on (no_hardware_pulsing=0, as on this board), hzeller EXITS if
# snd_bcm2835 is loaded (gpio.cc:701-712). So the module cannot be loaded today — the panel works —
# but an OS update that re-enables it means a dark panel and a watchdog restart loop, not "more
# flicker". This adds a modprobe blacklist so it can never load. The horn does not use it: it
# cannot, for the same reason. If the module IS loaded right now, something is different from what
# this file assumes, and the blacklist is refused.
#
# cmdline.txt is ONE line; a broken one is a board that does not boot. Do this AT THE BOARD, with
# someone watching the panel, never remotely. The edit is token-wise and validated before it is
# written (provisioning/lib-provision.sh), and a copy of the old line stays next to it on the FAT
# partition. Needs a reboot.
#
#   sudo bash ledbox-bridge/provisioning/setup-quiet-core.sh            # --check: read-only
#   sudo bash ledbox-bridge/provisioning/setup-quiet-core.sh --apply    # then: sudo reboot
#   sudo bash ledbox-bridge/provisioning/setup-quiet-core.sh --rollback # then: sudo reboot
#
# IF THE BOARD DOES NOT BOOT AFTERWARDS: power off, take the SD card out, put it in a laptop. The
# small FAT partition ("bootfs") holds cmdline.txt and cmdline.txt.bak-<date>; copy the .bak over
# cmdline.txt (one line, no line break added by the editor), card back in, power on. Or boot the
# spare card made by ops/image-board-sd.sh.
set -uo pipefail

LP_NAME=setup-quiet-core
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
. "$HERE/lib-provision.sh" || { echo "!! lib-provision.sh missing next to $0"; exit 1; }

MODE=${1:---check}
case "$MODE" in --check|--apply|--rollback) ;; *) sed -n '2,38p' "$0"; exit 2 ;; esac
lp_need_root "$MODE"

TOKENS="isolcpus=domain,managed_irq,3 nohz_full=3 rcu_nocbs=3 irqaffinity=0,1,2"
BLACKLIST=/etc/modprobe.d/ledbox-no-onboard-audio.conf
SETTING=/home/pi/ledbox/setting.ini
RC=0

check() {
  say "kernel command line"
  local dir; dir=$(lp_bootdir) || { echo "  !! no cmdline.txt found"; RC=1; return; }
  local line; line=$(cat "$dir/cmdline.txt")
  local t
  for t in $TOKENS; do
    if grep -qw -- "$t" <<<"$line"; then echo "  set      $t"; else echo "  missing  $t"; fi
  done
  say "in effect now (after the last boot)"
  echo "  isolated cpus:        $(cat /sys/devices/system/cpu/isolated 2>/dev/null || echo '?')   (want: 3)"
  echo "  nohz_full cpus:       $(cat /sys/devices/system/cpu/nohz_full 2>/dev/null || echo '?')   (empty = kernel without NO_HZ_FULL; harmless)"
  echo "  default irq affinity: $(cat /proc/irq/default_smp_affinity 2>/dev/null || echo '?')   (want: 7 = cpus 0-2)"
  local pid; pid=$(pgrep -x flushBuffer2 | head -1)
  if [ -n "$pid" ]; then
    echo "  flushBuffer2 threads (tid cpu rtprio):"
    ps -L -o tid=,psr=,rtprio= -p "$pid" | sed 's/^/    /'
    echo "    (the refresh thread is the rtprio-99 one; expect it on cpu 3)"
  else
    echo "  flushBuffer2 not running"
  fi
  say "on-board audio (must stay off with hardware pulsing)"
  local cfg; cfg="$dir/config.txt"
  echo "  config.txt:   $(grep -E '^\s*dtparam=audio' "$cfg" 2>/dev/null | tr '\n' ' ' || true)$(grep -qE '^\s*dtparam=audio' "$cfg" 2>/dev/null || echo 'no dtparam=audio line')"
  echo "  snd_bcm2835:  $(lsmod | grep -qw snd_bcm2835 && echo 'LOADED' || echo 'not loaded')"
  echo "  blacklisted:  $(grep -rlsw 'blacklist snd_bcm2835' /etc/modprobe.d /lib/modprobe.d 2>/dev/null | tr '\n' ' ' || true)"
  echo "  setting.ini:  $(grep -E '^\s*no_hardware_pulsing' "$SETTING" 2>/dev/null || echo '?')   (0 = hardware pulsing, the clean one)"
}

apply() {
  say "kernel command line — quiet core 3"
  lp_cmdline_edit "$TOKENS" "" || RC=1
  say "on-board audio blacklist"
  if lsmod | grep -qw snd_bcm2835; then
    echo "  !! snd_bcm2835 is LOADED right now — with hardware pulsing that cannot be, so this board is not"
    echo "     what this script assumes. Not blacklisting it; check no_hardware_pulsing in $SETTING."
    RC=1
  else
    lp_put "$BLACKLIST" 0644 <<'EOF'
# point-hub provisioning/setup-quiet-core.sh: flushBuffer2 runs with hardware pulsing, and hzeller's
# library exits if the on-board PWM audio driver is loaded. Keep it out, whatever an update enables.
blacklist snd_bcm2835
EOF
    [ $? = 1 ] && RC=1
  fi
  [ "$RC" = 0 ] && echo $'\n'"  reboot to take effect, with eyes on the panel:  sudo reboot"
}

case "$MODE" in
  --check) check ;;
  --apply) apply; [ -n "$LP_RUN" ] && echo "  backups: $LP_RUN   (undo: --rollback, then reboot)" ;;
  --rollback) say "rollback"; lp_restore || RC=1; [ "$RC" = 0 ] && echo "  reboot to take effect:  sudo reboot" ;;
esac
exit "$RC"
