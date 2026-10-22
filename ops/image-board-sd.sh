#!/usr/bin/env bash
# Image the LedBox board's SD card to the NAS — run FROM lenovoserver, never on the board.
#
# WHY: the board's only boot medium is an SD16G (Phison) dated 10/2019 that took ~6.4 GB/day of
# frame writes before the tmpfs fix (provisioning/README.md §4). It is the ONLY complete copy of
# the running system: the 0.552 port, the genuine 0.551 cpython-311 plugin bytecode, the staged
# Debian 9/11 libs, flushBuffer2, hostapd/NetworkManager/Tailscale state, keys and layouts. Every
# backup the board has (ledbox-config-backup/, the WORKING-SNAPSHOT tarballs) lives on the same
# card. A dead card today means rebuilding from RECOVERY.md with parts that exist nowhere else; with
# an image and a spare card in the case it is a two-minute swap any volunteer can do.
#
# WHAT IT DOES
#   1. checks the board, the card, the gpg key, the NAS and its free space BEFORE stopping anything
#   2. stops ledbox-bridge for a consistent data/ and settings.json (LIVE=1 leaves it running) and
#      syncs. The vendor app keeps painting — into RAM, if the tmpfs unit is on (checked below)
#   3. reads the card ONCE, on the board, up to the end of its last partition (the unallocated tail
#      is not part of the system; FULL=1 reads the whole card), compresses it there (zstd, else
#      gzip -1) and streams it here — compressed, because the link may be a hall Wi-Fi or a hotspot
#   4. here: decompresses a copy of the stream to prove it is intact and to take the raw image's
#      sha256 + byte count, encrypts the stream with gpg and sends that to the NAS as a .part file
#   5. restarts the bridge the moment the read is done — and on EVERY exit path, via a trap
#   6. renames the .part into place only if every stage of the pipe succeeded, the raw byte count is
#      exactly what was read, and the NAS holds exactly the bytes sent (and the same sha256, where
#      the NAS has sha256sum). A .txt manifest goes beside it: hashes, sizes, partition table, and
#      how to write a spare. Nothing secret is in the manifest.
#   7. SPARE=/dev/sdX also writes that same single read to a card in a USB reader plugged into the
#      BOARD, and then re-reads it and checks it against the raw sha256: the spare is bit-identical
#      to the image on the NAS. This is the spare that gets taped inside the case.
#
# The image holds the house and school Wi-Fi credentials, the AP passphrase, the tailnet node key,
# the SSH host keys and the Directus token. It is therefore NEVER stored unencrypted: gpg to
# GPG_RECIPIENT (default the club backup key, the same one the club's database backups use). Its
# public key must be in this host's keyring — the script refuses before stopping anything if not.
#
#   ./ops/image-board-sd.sh                               # board `ledbox`, NAS `nas-ts`
#   SPARE=/dev/sda ./ops/image-board-sd.sh                # + write the spare in a reader on the board
#   BOARD=pi@192.168.5.1 JUMP=openvolley ./ops/image-board-sd.sh
#   OUT_DIR=/media/usb ./ops/image-board-sd.sh            # no NAS reachable: write the .gpg here instead
#   GPG_RECIPIENT="backup@kscw.ch <your key id>" ...      # several recipients, space-separated
#   LIVE=1 ...                                            # leave the bridge running (see below)
#
# LIVE=1: imaging a mounted system is never a perfect snapshot — the read takes minutes and the
# card keeps changing under it. With the bridge stopped the writes are reduced to the journal and
# the vendor app's own logs, and ext4's journal makes the clone boot like a board that lost power.
# With it running, data/ (match history), settings.json and the logs can be caught half-written.
# Use LIVE=1 only when the bridge cannot be stopped (a match on), and image again afterwards.
#
# NAS layout: $NAS_DIR next to the club's other backups (/volume1/backups/directus-kscw, written by
# ~/stacks/kscw-backup-pull). Same transport as that script: DSM refuses rsync for this user, so it
# is ssh `cat` into a dot-.part file and `mv` once complete. Nothing prunes these — they are rare
# and each one is a full restore point; delete old ones by hand.
#
# Exit status: 0 only when the image is in place and verified (and the spare, if asked for).
set -uo pipefail   # not -e: the trap has to get the bridge back up whatever fails

BOARD=${BOARD:-ledbox}
JUMP=${JUMP:-}
J=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=8)
[ -n "$JUMP" ] && J+=(-J "$JUMP")
NAS=${NAS:-nas-ts}
NAS_DIR=${NAS_DIR:-/volume1/backups/ledbox-c0270}
NSSH=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8)
OUT_DIR=${OUT_DIR:-}
GPG_RECIPIENT=${GPG_RECIPIENT:-backup@kscw.ch}
LIVE=${LIVE:-0}
FULL=${FULL:-0}
SPARE=${SPARE:-}
SPARE_YES=${SPARE_YES:-0}
STAMP=$(date +%Y%m%d-%H%M)

b() { ssh "${J[@]}" "$BOARD" "$@"; }
die() { echo "!! $*"; exit 1; }
where() { if [ -n "$OUT_DIR" ]; then echo "$OUT_DIR"; else echo "$NAS:$NAS_DIR"; fi; }

# sha256 + byte count of stdin in one pass ("<hex> <bytes>").
HASHPY='import hashlib,sys
h=hashlib.sha256(); n=0
for c in iter(lambda: sys.stdin.buffer.read(1<<20), b""):
    h.update(c); n+=len(c)
print(h.hexdigest(), n)'

echo "== 0) this host: tools and the encryption key =="
for t in gpg python3 ssh; do command -v "$t" >/dev/null || die "$t not installed here"; done
RCPT=()
for r in $GPG_RECIPIENT; do
  gpg --batch --list-keys -- "$r" >/dev/null 2>&1 || die "no public key for '$r' in this keyring.
   The image holds Wi-Fi passphrases and the tailnet node key, so it is never stored unencrypted.
   Import the club backup key (it is a PUBLIC key; the VPS encrypts the club's DB backups with it):
     ssh hetzner 'gpg --export --armor backup@kscw.ch' | gpg --import
   or set GPG_RECIPIENT to a key you hold."
  RCPT+=(--recipient "$r")
done
echo probe | gpg --batch --quiet --trust-model always --encrypt "${RCPT[@]}" >/dev/null 2>&1 \
  || die "gpg cannot encrypt to '$GPG_RECIPIENT' (expired or unusable key?) — nothing was touched"
echo "  encrypting to: $GPG_RECIPIENT"

echo "== 1) board: the card, swap, frame buffers =="
b hostname >/dev/null || die "board not reachable as '$BOARD'${JUMP:+ via $JUMP} — powered on? tailnet up? (~2 min from cold)"
FACTS=$(b bash -s <<'EOF'
root=$(findmnt -no SOURCE / 2>/dev/null)
n=$(lsblk -no PKNAME "$root" 2>/dev/null | head -1)
echo "HOST=$(hostname)"
echo "ROOT=$root"
echo "DISK=/dev/$n"
echo "DISK_BYTES=$(( $(cat /sys/block/$n/size 2>/dev/null || echo 0) * 512 ))"
end=0
for p in /sys/block/$n/$n*; do
  [ -f "$p/start" ] || continue
  e=$(( $(cat "$p/start") + $(cat "$p/size") ))
  [ "$e" -gt "$end" ] && end=$e
done
echo "END_BYTES=$(( end * 512 ))"
echo "CARD=$(cat /sys/block/$n/device/name 2>/dev/null || echo ?) $(cat /sys/block/$n/device/date 2>/dev/null || echo ?)"
echo "ZSTD=$(command -v zstd >/dev/null && echo 1 || echo 0)"
echo "SUDO=$(sudo -n true 2>/dev/null && echo ok || echo no)"
echo "BRIDGE=$(systemctl is-active ledbox-bridge 2>/dev/null)"
echo "TMPFS=$(mountpoint -q /home/pi/ledbox/www/buffer.png 2>/dev/null && echo ram || echo card)"
echo "MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
echo "DPHYS=$(systemctl is-enabled dphys-swapfile 2>/dev/null || echo absent)"
swapon --show=NAME,TYPE,SIZE,USED --noheadings --raw 2>/dev/null | sed 's/^/SWAP=/'
EOF
)
fact() { sed -n "s/^$1=//p" <<<"$FACTS" | head -1; }
HOST=$(fact HOST); DISK=$(fact DISK); DISK_BYTES=$(fact DISK_BYTES); END_BYTES=$(fact END_BYTES)
ZSTD=$(fact ZSTD)
echo "  host $HOST, root $(fact ROOT) on $DISK — $(fact CARD), $((DISK_BYTES / 1000000)) MB"
[ "$(fact SUDO)" = ok ] || die "passwordless sudo is not available to '$BOARD' — nothing was touched"
[[ "$DISK" =~ ^/dev/(mmcblk[0-9]+|sd[a-z])$ ]] || die "could not tell which disk the root filesystem is on (got '$DISK')"
[ "${END_BYTES:-0}" -gt 0 ] && [ "$END_BYTES" -le "$DISK_BYTES" ] || die "could not read the partition layout of $DISK"
if [ "$FULL" = 1 ]; then COUNT=$DISK_BYTES; else COUNT=$END_BYTES; fi
echo "  image: the first $COUNT bytes ($((COUNT / 1000000)) MB)$([ "$FULL" = 1 ] && echo ', the whole card' || echo ' = to the end of the last partition')"
if [ "$ZSTD" = 1 ]; then EXT=zst; DECOMP=(zstd -q -dc); else EXT=gz; DECOMP=(gzip -dc); fi
command -v "${DECOMP[0]}" >/dev/null || die "${DECOMP[0]} is needed here to check the stream"
echo "  compression on the board: $([ "$ZSTD" = 1 ] && echo 'zstd -3' || echo 'gzip -1 (no zstd on the board)')"
[ "$(fact TMPFS)" = ram ] || echo "  !! buffer.png is on the CARD, not in RAM: the vendor app rewrites it every frame during the read.
     The image is still usable (that file is regenerated on the next frame); 'sudo ledbox-buffer-tmpfs start' fixes it."

# Swap: report only, and say how — this script never changes the board.
SWAPS=$(sed -n 's/^SWAP=//p' <<<"$FACTS")
if [ -z "$SWAPS" ]; then
  echo "  swap: none active (dphys-swapfile: $(fact DPHYS))"
else
  echo "  swap: $(tr '\n' ';' <<<"$SWAPS") — RAM $(fact MEM_MB) MB, dphys-swapfile $(fact DPHYS)"
  if grep -qvE '^/dev/zram' <<<"$SWAPS"; then
    echo "  !! swap lives on the SD card. To stop it wearing the card (AFTER this image, with no match on):"
    echo "       ssh $BOARD 'sudo dphys-swapfile swapoff && sudo dphys-swapfile uninstall && sudo systemctl disable --now dphys-swapfile'"
    echo "     Only if USED above is small: a board that really needs swap needs a look, not this."
  fi
fi

echo "== 2) destination: $(where) =="
NAME="$(tr -c 'a-zA-Z0-9-\n' '-' <<<"${HOST:-ledbox}" | tr -d '\n')-sd-$STAMP.img.$EXT.gpg"
if [ -n "$OUT_DIR" ]; then
  mkdir -p "$OUT_DIR" && [ -w "$OUT_DIR" ] || die "cannot write to $OUT_DIR"
  AVAIL=$(( $(df -Pk "$OUT_DIR" | awk 'NR==2{print $4}') * 1024 ))
else
  AVAIL=$(ssh "${NSSH[@]}" "$NAS" "mkdir -p '$NAS_DIR' && test -w '$NAS_DIR' && df -Pk '$NAS_DIR' | awk 'NR==2{print \$4}'") \
    || die "NAS '$NAS' not reachable, or $NAS_DIR not writable — nothing was touched (OUT_DIR=... writes locally instead)"
  AVAIL=$(( AVAIL * 1024 ))
fi
# Worst case: an image that does not compress at all.
[ "$AVAIL" -gt "$COUNT" ] || die "only $((AVAIL / 1000000)) MB free at $(where), the image can be up to $((COUNT / 1000000)) MB"
echo "  $((AVAIL / 1000000000)) GB free; file will be $NAME"

if [ -n "$SPARE" ]; then
  echo "== 2b) spare card on the board: $SPARE =="
  [[ "$SPARE" =~ ^/dev/sd[a-z]$ ]] || die "SPARE must be a whole USB disk like /dev/sda (got '$SPARE')"
  [ "$SPARE" != "$DISK" ] || die "SPARE is the board's own card"
  # -P (KEY="value" pairs), not columns: an empty TRAN or MODEL would shift every column after it.
  SP=$(b "lsblk -dbnP -o TYPE,TRAN,SIZE,MODEL '$SPARE' 2>/dev/null; echo MOUNTED=\$(lsblk -no MOUNTPOINT '$SPARE' 2>/dev/null | grep -c .)")
  spv() { sed -n "s/.*$1=\"\([^\"]*\)\".*/\1/p" <<<"$SP" | head -1; }
  SP_TYPE=$(spv TYPE); SP_TRAN=$(spv TRAN); SP_SIZE=$(spv SIZE); SP_MODEL=$(spv MODEL)
  SP_MOUNTED=$(sed -n 's/^MOUNTED=//p' <<<"$SP")
  [ "$SP_TYPE" = disk ] || die "$SPARE is not a whole disk on the board (lsblk says '${SP_TYPE:-nothing}') — plug the reader in, check: ssh $BOARD lsblk"
  [ "$SP_TRAN" = usb ] || die "$SPARE is not a USB device ($SP_TRAN) — refusing to overwrite it"
  [ "${SP_MOUNTED:-1}" = 0 ] || die "$SPARE has a mounted partition — unmount it first"
  [ "${SP_SIZE:-0}" -ge "$COUNT" ] || die "$SPARE is $((SP_SIZE / 1000000)) MB, the image needs $((COUNT / 1000000)) MB"
  echo "  $SPARE: USB, $((SP_SIZE / 1000000000)) GB, ${SP_MODEL:-?} — EVERYTHING ON IT WILL BE OVERWRITTEN"
  if [ "$SPARE_YES" != 1 ]; then
    [ -t 0 ] || die "not a terminal — run with SPARE_YES=1 to confirm overwriting $SPARE"
    read -r -p "  type YES to overwrite $SPARE: " ans
    [ "$ans" = YES ] || die "not confirmed — nothing was touched"
  fi
fi

T=$(mktemp -d) || die "mktemp failed"
STOPPED=0
PART_LEFT=0
restart_bridge() {
  [ "$STOPPED" = 1 ] || return 0
  STOPPED=0
  echo "== restarting ledbox-bridge =="
  b 'sudo -n systemctl start ledbox-bridge; sleep 3; echo "  bridge: $(systemctl is-active ledbox-bridge)"' \
    || echo "!! could NOT restart the bridge — do it by hand: ssh $BOARD 'sudo systemctl start ledbox-bridge'"
}
cleanup() {
  restart_bridge
  if [ "$PART_LEFT" = 1 ]; then
    if [ -n "$OUT_DIR" ]; then rm -f "$OUT_DIR/.$NAME.part"
    else ssh "${NSSH[@]}" "$NAS" "rm -f '$NAS_DIR/.$NAME.part'" >/dev/null 2>&1; fi
    echo "  (the incomplete .part was removed)"
  fi
  rm -rf "$T"
}
trap cleanup EXIT
trap 'echo; echo "!! interrupted"; exit 130' INT TERM HUP

echo "== 3) stop the bridge =="
if [ "$LIVE" = 1 ]; then
  echo "  LIVE=1 — leaving it running ($(fact BRIDGE)); data/ and settings.json may be caught mid-write"
  b 'sync'
elif [ "$(fact BRIDGE)" = active ]; then
  b 'sudo -n systemctl stop ledbox-bridge && sync' || die "could not stop the bridge"
  STOPPED=1
  echo "  stopped and synced (restarts as soon as the read is done)"
else
  echo "  not running ($(fact BRIDGE)) — synced only"; b 'sync'
fi

# Runs ON the board. stdout carries the compressed image and nothing else; every message goes to
# stderr. With a spare, the ONE read is split by tee: one copy to the compressor, one to a dd onto
# the spare. tee -p keeps feeding the compressor if the spare's writer dies — the NAS image must not
# fail because a USB reader did; the spare is checked on its own afterwards.
cat > "$T/remote.sh" <<'EOF'
DISK=$1 COUNT=$2 SPARE=$3 ZSTD=$4
if [ "$ZSTD" = 1 ]; then COMP=(zstd -q -c -T0 -3); else COMP=(gzip -1 -c); fi
if [ -z "$SPARE" ]; then
  sudo -n dd if="$DISK" bs=4M count="$COUNT" iflag=count_bytes status=progress | "${COMP[@]}"
  rc=("${PIPESTATUS[@]}")
  [ "${rc[0]}" = 0 ] && [ "${rc[1]}" = 0 ]; exit $?
fi
D=$(mktemp -d) && mkfifo "$D/spare" || { echo "!! no fifo for the spare" >&2; exit 90; }
sudo -n dd of="$SPARE" bs=4M iflag=fullblock conv=fsync status=none < "$D/spare" &
W=$!
sudo -n dd if="$DISK" bs=4M count="$COUNT" iflag=count_bytes status=progress | tee -p "$D/spare" | "${COMP[@]}"
rc=("${PIPESTATUS[@]}")
wait "$W"; w=$?
rm -rf "$D"
echo "  spare writer finished: exit $w" >&2
[ "${rc[0]}" = 0 ] && [ "${rc[2]}" = 0 ]; exit $?
EOF

echo "== 4) read the card → compress → check → encrypt → $(where) =="
echo "  expect roughly $((COUNT / 20000000 / 60 + 1))-$((COUNT / 8000000 / 60 + 1)) min (card read ~8-20 MB/s; slower over a hotspot)"
mkfifo "$T/dec" "$T/enc" || die "mkfifo failed"
( "${DECOMP[@]}" < "$T/dec" | python3 -I -c "$HASHPY" > "$T/raw.sum" ) &
PD=$!
( python3 -I -c "$HASHPY" < "$T/enc" > "$T/enc.sum" ) &
PE=$!
if [ -n "$OUT_DIR" ]; then
  SINK=(sh -c 'umask 077; exec cat > "$1"' sh "$OUT_DIR/.$NAME.part")
else
  SINK=(ssh "${NSSH[@]}" "$NAS" "umask 077; cat > '$NAS_DIR/.$NAME.part'")
fi
PART_LEFT=1
b bash -s -- "$DISK" "$COUNT" "$SPARE" "$ZSTD" < "$T/remote.sh" \
  | tee "$T/dec" \
  | gpg --batch --quiet --trust-model always --compress-algo none --encrypt "${RCPT[@]}" \
  | tee "$T/enc" \
  | "${SINK[@]}"
PS=("${PIPESTATUS[@]}")
wait "$PD"; WD=$?
wait "$PE"; WE=$?

restart_bridge

echo "== 5) verify =="
read -r RAW_SHA RAW_BYTES < "$T/raw.sum" 2>/dev/null
read -r ENC_SHA ENC_BYTES < "$T/enc.sum" 2>/dev/null
echo "  pipe exit codes: board ${PS[0]}, tee ${PS[1]}, gpg ${PS[2]}, tee ${PS[3]}, store ${PS[4]}; check $WD/$WE"
FAIL=""
for i in 0 1 2 3 4; do [ "${PS[$i]}" = 0 ] || FAIL="$FAIL pipe-stage-$i"; done
[ "$WD" = 0 ] && [ "$WE" = 0 ] || FAIL="$FAIL checker"
[ "${RAW_BYTES:-0}" = "$COUNT" ] || FAIL="$FAIL raw-bytes(${RAW_BYTES:-?}!=$COUNT)"
[ -n "${ENC_SHA:-}" ] || FAIL="$FAIL no-encrypted-hash"
if [ -n "$OUT_DIR" ]; then
  GOT=$(stat -c %s "$OUT_DIR/.$NAME.part" 2>/dev/null)
  STORED_SHA=$(sha256sum "$OUT_DIR/.$NAME.part" | cut -d' ' -f1)
else
  GOT=$(ssh -n "${NSSH[@]}" "$NAS" "stat -c %s '$NAS_DIR/.$NAME.part'" 2>/dev/null)
  STORED_SHA=$(ssh -n "${NSSH[@]}" "$NAS" "command -v sha256sum >/dev/null && sha256sum '$NAS_DIR/.$NAME.part' | cut -d' ' -f1" 2>/dev/null)
fi
[ "$GOT" = "${ENC_BYTES:-x}" ] || FAIL="$FAIL stored-size(${GOT:-?}!=${ENC_BYTES:-?})"
if [ -n "$STORED_SHA" ]; then
  [ "$STORED_SHA" = "$ENC_SHA" ] || FAIL="$FAIL stored-sha256"
else
  echo "  (no sha256sum at $(where) — checked the size only)"
fi
[ -z "$FAIL" ] || die "image NOT verified:$FAIL — the .part is removed; the card was not changed. Run again."

if [ -n "$OUT_DIR" ]; then
  mv -f "$OUT_DIR/.$NAME.part" "$OUT_DIR/$NAME" || die "could not rename the .part"
else
  ssh -n "${NSSH[@]}" "$NAS" "mv -f '$NAS_DIR/.$NAME.part' '$NAS_DIR/$NAME'" || die "could not rename the .part on the NAS"
fi
PART_LEFT=0
echo "  raw image   sha256 $RAW_SHA  ($RAW_BYTES bytes)"
echo "  stored file sha256 $ENC_SHA  ($ENC_BYTES bytes, $((100 * ENC_BYTES / RAW_BYTES))% of raw)"
echo "  OK: $(where)/$NAME"

PTABLE=$(b "sudo -n sfdisk -d '$DISK'" 2>/dev/null || echo '(sfdisk -d failed)')
MANIFEST="LedBox SD card image
file:          $NAME
taken:         $(date -Is) from $HOST via $BOARD${JUMP:+ (jump $JUMP)}
card:          $DISK, $(fact CARD), $DISK_BYTES bytes
covers:        the first $COUNT bytes$([ "$FULL" = 1 ] && echo ' (the whole card)' || echo ' (to the end of the last partition)')
bridge:        $([ "$LIVE" = 1 ] && echo 'left RUNNING during the read (LIVE=1)' || echo 'stopped during the read')
raw image:     sha256 $RAW_SHA  bytes $RAW_BYTES
compressed:    $([ "$EXT" = zst ] && echo 'zstd -3' || echo 'gzip -1') on the board
stored file:   gpg to $GPG_RECIPIENT — sha256 $ENC_SHA  bytes $ENC_BYTES
spare written: ${SPARE:-no}

partition table (sfdisk -d):
$PTABLE

Write it to a card (USB reader; find it with lsblk -d -o NAME,SIZE,MODEL,TRAN — TRAN usb):
  ssh $NAS \"cat '$NAS_DIR/$NAME'\" | gpg --decrypt | ${DECOMP[*]} | sudo dd of=/dev/sdX bs=4M conv=fsync status=progress
  sudo blockdev --flushbufs /dev/sdX; sudo head -c $RAW_BYTES /dev/sdX | sha256sum   # must print $RAW_SHA
"
if [ -n "$OUT_DIR" ]; then
  printf '%s' "$MANIFEST" > "$OUT_DIR/$NAME.txt"
else
  printf '%s' "$MANIFEST" | ssh "${NSSH[@]}" "$NAS" "cat > '$NAS_DIR/$NAME.txt'" || echo "  !! manifest not written (the image is fine)"
fi
echo "  manifest: $(where)/$NAME.txt"

SPARE_OK=1
if [ -n "$SPARE" ]; then
  echo "== 6) verify the spare on the board: $SPARE =="
  # Flush and drop the reader's page cache, then read with O_DIRECT: a plain read straight after
  # the write is served from RAM and would "verify" what was sent, not what the card holds.
  SP_SHA=$(b "sync; sudo -n blockdev --flushbufs '$SPARE'; sudo -n dd if='$SPARE' bs=4M count=$COUNT iflag=count_bytes,direct status=none | sha256sum | cut -d' ' -f1")
  if [ "$SP_SHA" = "$RAW_SHA" ]; then
    echo "  OK: $SPARE is bit-identical to the image ($RAW_SHA)"
    echo "  pull the reader out now. Label the card: \"LedBox C0270 clone $(date +%F) — this board only\"."
  else
    echo "  !! the spare does NOT match the image (${SP_SHA:-no answer}). Do not keep it as the spare."
    SPARE_OK=0
  fi
fi

cat <<EOF

== the spare card ==
A 32 GB high-endurance card (SanDisk High Endurance or Samsung PRO Endurance) in a USB reader.
${SPARE:+(Done above, from the same read.) }Later, from the NAS copy, on a Linux machine that holds the decryption key:
  lsblk -d -o NAME,SIZE,MODEL,TRAN                      # the reader: TRAN usb, ~29.7G — NOT your own disk
  ssh $NAS "cat '$NAS_DIR/$NAME'" | gpg --decrypt | ${DECOMP[*]} | sudo dd of=/dev/sdX bs=4M conv=fsync status=progress
  sudo blockdev --flushbufs /dev/sdX; sudo head -c $RAW_BYTES /dev/sdX | sha256sum   # must print $RAW_SHA
Raspberry Pi Imager instead: decrypt to a file first (it is plaintext with secrets in it — delete it after):
  ssh $NAS "cat '$NAS_DIR/$NAME'" | gpg --decrypt > ${NAME%.gpg}
  Imager → Choose OS → Use custom → that file → the reader. When it offers OS customisation: NO.
  (Customisation would rewrite the clone's user, Wi-Fi and SSH setup on first boot.)
The extra space on a 32 GB card stays unused — that is fine; do not expand it.
The clone has the board's identity (tailnet node key, SSH host keys): only ever boot it IN THIS
BOARD, never in a second Pi while the board is on. Refresh it after any milestone (openscore
cutover, firewall commit, a provisioning session).
EOF
[ "$SPARE_OK" = 1 ] || exit 1
exit 0
