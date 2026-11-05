#!/bin/bash
# Split a Pi OS SD card into root + /data. Run on a LAPTOP (not the Pi), as root, with the card in a
# reader and NOT mounted. Works on a freshly flashed card, or on one that has already booted and grown
# its root over the whole card, as long as the files fit in the new size. Keeps a card's files, but
# have a copy of anything you cannot lose.
#
#   sudo ./prepare-card.sh /dev/sdX [root size in GiB, default 12]
#
# Refuses anything that is not a removable disk. Read what it prints before you type YES.
set -euo pipefail
DEV=${1:?usage: prepare-card.sh /dev/sdX [root GiB]}
ROOT_GIB=${2:-12}
[ "$(id -u)" = 0 ] || { echo "Run as root."; exit 1; }
[ -b "$DEV" ] || { echo "$DEV is not a block device."; exit 1; }
NAME=$(basename "$DEV")
[ "$(cat "/sys/block/$NAME/removable" 2>/dev/null || echo 0)" = 1 ] || case "$NAME" in mmcblk*) : ;; *) echo "$DEV is not removable: refusing."; exit 1 ;; esac
if lsblk -no MOUNTPOINT "$DEV" | grep -q .; then echo "$DEV has something mounted: unmount it first."; exit 1; fi
case "$NAME" in mmcblk*|nvme*) P=p ;; *) P= ;; esac
ROOT="$DEV${P}2"; DATA="$DEV${P}3"
lsblk -o NAME,SIZE,FSTYPE,LABEL,MODEL "$DEV"
[ -b "$ROOT" ] || { echo "No second partition: flash Raspberry Pi OS first."; exit 1; }
[ ! -b "$DATA" ] || { echo "$DATA already exists: nothing to do."; exit 0; }
read -r -p "Make the root ${ROOT_GIB} GiB and the rest /data on $DEV? Type YES: " ok
[ "$ok" = YES ] || { echo "Stopped."; exit 1; }
# e2fsck exits 1 when it fixed something: that is fine, anything higher is not.
rc=0; e2fsck -fy "$ROOT" || rc=$?
[ "$rc" -le 1 ] || { echo "e2fsck failed on $ROOT ($rc): stopping, nothing was changed."; exit 1; }
# The order matters when shrinking: the filesystem first, then the partition. The other way round
# cuts the end off a filesystem that has already grown over the whole card, which destroys it.
resize2fs "$ROOT" "${ROOT_GIB}G"
echo ", ${ROOT_GIB}G" | sfdisk --no-reread --no-tell-kernel -N 2 "$DEV"
echo ",,L" | sfdisk --no-reread --no-tell-kernel -a "$DEV"
partprobe "$DEV"; sleep 2
resize2fs "$ROOT"
[ -b "$DATA" ] || { echo "$DATA did not appear: stopping before formatting anything."; exit 1; }
mkfs.ext4 -q -L pointhub-data "$DATA"
M=$(mktemp -d); mount "$ROOT" "$M"
mkdir -p "$M/data"
grep -q 'LABEL=pointhub-data' "$M/etc/fstab" || echo 'LABEL=pointhub-data /data ext4 defaults,noatime,commit=5 0 2' >> "$M/etc/fstab"
umount "$M"; rmdir "$M"
BOOT=$(mktemp -d); mount "$DEV${P}1" "$BOOT"
# Pi OS grows the root at first boot unless this is off.
sed -i 's| *init=/usr/lib/raspberrypi-sys-mods/firstboot||; s| *init=/usr/lib/raspi-config/init_resize.sh||' "$BOOT/cmdline.txt"
umount "$BOOT"; rmdir "$BOOT"
echo "Done: root ${ROOT_GIB} GiB, /data on $DATA."
