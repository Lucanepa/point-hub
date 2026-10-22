# Shared helpers for the one-off board provisioning scripts in this directory. SOURCED, never run:
#
#   LP_NAME=setup-foo
#   . "$(dirname "$(readlink -f "$0")")/lib-provision.sh" || { echo "!! lib-provision.sh missing"; exit 1; }
#
# Two things live here because getting either wrong once is already once too often.
#
# 1. BACKUPS THAT A ROLLBACK CAN FIND, AND THAT NOTHING LOADS BY ACCIDENT.
#    harden-board.sh backs a file up next to itself, which is right for sshd_config and wrong for
#    the places the newer scripts write: dnsmasq loads EVERY file in /etc/dnsmasq.d except
#    *.dpkg-*, and NetworkManager loads files in system-connections whose suffix it does not know —
#    so a `foo.conf.bak-<date>` there is a second, LIVE copy of the config. A run's backups go to
#    /var/backups/ledbox/<script>-<stamp>/ under their original paths instead. A path that did not
#    exist before is recorded as absent, so a rollback deletes it again rather than leaving a new
#    file behind. `--rollback` restores the newest run of that script that changed anything and
#    renames it *.rolled-back, so a second `--rollback` steps back one run further. Apply one step
#    per run and each step can be undone on its own.
#
# 2. EDITING cmdline.txt. It is ONE line. A line break in the middle of it, or a lost `root=`, is a
#    board that does not boot, and the only fix is the card in a laptop. So the edit is token-wise
#    (never a sed over the whole line), it refuses a file that is not one line to begin with, it
#    checks the result keeps the same root= and stays one line before anything is written, it
#    writes a copy next to the file on the FAT partition (the one place a laptop can reach when the
#    board will not boot) as well as to the backup dir, and it swaps the file in with a rename.

LP_STAMP=$(date +%Y%m%d-%H%M%S)
LP_BACKUPS=${LP_BACKUPS:-/var/backups/ledbox}
LP_RUN=""         # this run's backup dir; created on the first lp_bak, so a no-op run leaves none
LP_SELF="$(readlink -f "$0")"

say() { printf '\n=== %s ===\n' "$*"; }

lp_need_root() {
  [ "$(id -u)" = 0 ] || { echo "!! must run as root — try: sudo bash $LP_SELF $*"; exit 1; }
}

# lp_bak <path>... — copy each path into this run's backup dir before it is changed. The FIRST copy
# of a path in a run wins: it is the state before this run, which is what a rollback has to bring
# back. Returns non-zero if a copy failed — callers must not edit a file they could not back up.
lp_bak() {
  local p
  if [ -z "$LP_RUN" ]; then
    LP_RUN="$LP_BACKUPS/${LP_NAME:?LP_NAME not set}-$LP_STAMP"
    install -d -m 0700 "$LP_BACKUPS" "$LP_RUN" || { echo "  !! cannot create $LP_RUN"; return 1; }
  fi
  for p in "$@"; do
    grep -qxF -- "$p" "$LP_RUN/PATHS" 2>/dev/null && continue
    if [ -e "$p" ]; then
      cp -a --parents -- "$p" "$LP_RUN/" 2>/dev/null || cp --parents -- "$p" "$LP_RUN/" \
        || { echo "  !! could not back up $p — not touching it"; return 1; }
    else
      printf '%s\n' "$p" >> "$LP_RUN/ABSENT"
    fi
    printf '%s\n' "$p" >> "$LP_RUN/PATHS"
  done
  return 0
}

# lp_put <path> <mode> — write stdin to <path> (root-owned) only if it differs from what is there,
# backing up first. This is what makes a re-run a true no-op: no write, no backup run, nothing for a
# rollback to "undo". Returns 0 = written, 1 = failed, 2 = already identical.
lp_put() {
  local p="$1" mode="$2" tmp
  tmp=$(mktemp) || return 1
  cat > "$tmp"
  if [ -f "$p" ] && cmp -s "$tmp" "$p"; then rm -f "$tmp"; echo "  unchanged: $p"; return 2; fi
  lp_bak "$p" || { rm -f "$tmp"; return 1; }
  if install -D -o root -g root -m "$mode" "$tmp" "$p"; then rm -f "$tmp"; echo "  wrote $p"; return 0; fi
  rm -f "$tmp"; echo "  !! could not write $p"; return 1
}

# lp_restore — put back every path the newest not-yet-rolled-back run of this script recorded.
# Prints what it did; returns 1 if there was nothing to restore or any path failed (and then
# leaves the run in place, so it can be retried).
lp_restore() {
  local run p bad=0
  run=$(ls -1d "$LP_BACKUPS/${LP_NAME:?}"-2* 2>/dev/null | grep -v '\.rolled-back$' | sort | tail -1)
  if [ -z "$run" ] || [ ! -s "$run/PATHS" ]; then
    echo "  nothing to roll back: no run under $LP_BACKUPS/$LP_NAME-*"
    return 1
  fi
  echo "  restoring the run in $run"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if grep -qxF -- "$p" "$run/ABSENT" 2>/dev/null; then
      if rm -f -- "$p"; then echo "  removed  $p (it did not exist before)"; else echo "  !! could not remove $p"; bad=1; fi
    elif cp -a -- "$run$p" "$p" 2>/dev/null || cp -- "$run$p" "$p"; then
      echo "  restored $p"
    else
      echo "  !! could not restore $p (the copy is still at $run$p)"; bad=1
    fi
  done < "$run/PATHS"
  sync
  [ "$bad" = 0 ] || return 1
  mv -- "$run" "$run.rolled-back"
  return 0
}

# The FAT boot partition. Bookworm mounts it at /boot/firmware and leaves a "this file has moved"
# stub at /boot/cmdline.txt — editing the stub changes nothing and looks like it worked.
lp_bootdir() {
  if mountpoint -q /boot/firmware 2>/dev/null && [ -f /boot/firmware/cmdline.txt ]; then echo /boot/firmware
  elif [ -f /boot/cmdline.txt ] && ! grep -qi 'moved' /boot/cmdline.txt; then echo /boot
  else return 1
  fi
}

# lp_cmdline_edit "<key=value tokens to set>" "<keys to remove>"
# Sets each token (replacing any token with the same key) and drops the listed keys. Prints the
# before/after and returns 0 when the file now holds the wanted line (changed or already so), 1 when
# it refused. Never writes anything it has not validated.
lp_cmdline_edit() {
  local add="$1" del="$2" dir f old new tok key keep k
  dir=$(lp_bootdir) || { echo "  !! no cmdline.txt found (neither /boot/firmware nor /boot)"; return 1; }
  f="$dir/cmdline.txt"
  if [ "$(grep -c '' "$f")" -ne 1 ] || grep -q $'\r' "$f"; then
    echo "  !! $f is not exactly one line (or has a CR) — refusing to edit a file that is already odd"
    return 1
  fi
  old=$(cat "$f")
  local -a toks out=()
  read -ra toks <<<"$old"
  local drop=" "
  for tok in $add; do drop+="${tok%%=*} "; done
  for k in $del; do drop+="$k "; done
  for tok in "${toks[@]}"; do
    key=${tok%%=*}
    case "$drop" in *" $key "*) continue ;; esac
    out+=("$tok")
  done
  for tok in $add; do out+=("$tok"); done
  new="${out[*]}"

  # Same root= as before, still one line, not absurdly long (the firmware appends its own
  # parameters to this line).
  keep=$(printf '%s\n' "${toks[@]}" | grep '^root=' | head -1)
  if [ -z "$keep" ] || ! printf '%s\n' "${out[@]}" | grep -qxF -- "$keep"; then
    echo "  !! the new line would lose '$keep' — refusing"; return 1
  fi
  case "$new" in *$'\n'*|*$'\r'*) echo "  !! the new line contains a line break — refusing"; return 1 ;; esac
  if [ "${#new}" -gt 900 ]; then echo "  !! the new line would be ${#new} chars — refusing"; return 1; fi

  echo "  file:   $f"
  echo "  before: $old"
  if [ "$new" = "$old" ]; then
    echo "  already as wanted — nothing written"
    return 0
  fi
  echo "  after:  $new"
  lp_bak "$f" || return 1
  cp -- "$f" "$f.bak-$LP_STAMP" || { echo "  !! could not write $f.bak-$LP_STAMP — not editing"; return 1; }
  printf '%s\n' "$new" > "$f.ledbox-new" && sync && mv -f -- "$f.ledbox-new" "$f" && sync \
    || { echo "  !! writing $f FAILED — check it NOW against $f.bak-$LP_STAMP before any reboot"; return 1; }
  if [ "$(cat "$f")" != "$new" ]; then
    echo "  !! $f does not read back as written — restore $f.bak-$LP_STAMP before any reboot"; return 1
  fi
  echo "  written; a copy of the old line is at $f.bak-$LP_STAMP (reachable from a laptop)"
  return 0
}

# lp_config_line "<line>" — make sure config.txt carries this exact line, appended under an [all]
# section header so it can never land inside a [pi3]/[cm4]-style conditional block at the end.
lp_config_line() {
  local line="$1" dir f
  dir=$(lp_bootdir) || { echo "  !! no config.txt found"; return 1; }
  f="$dir/config.txt"
  [ -f "$f" ] || { echo "  !! $f missing"; return 1; }
  if grep -qxF -- "$line" "$f"; then echo "  $f already has '$line'"; return 0; fi
  lp_bak "$f" || return 1
  cp -- "$f" "$f.bak-$LP_STAMP" || { echo "  !! could not write $f.bak-$LP_STAMP — not editing"; return 1; }
  printf '\n[all]\n%s\n' "$line" >> "$f" && sync || { echo "  !! append to $f FAILED"; return 1; }
  echo "  appended '$line' to $f (old copy: $f.bak-$LP_STAMP)"
}

# The interface this SSH session comes in on ("local" without SSH). Scripts that restart hostapd
# or dnsmasq use it to refuse cutting the very link they are being run over.
lp_session_dev() {
  local client="${SSH_CONNECTION:-}"; client=${client%% *}
  [ -n "$client" ] || { echo local; return; }
  ip route get "$client" 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1
}
