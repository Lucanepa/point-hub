#!/bin/bash
# LedBox board hardening, steps 1-4. Daemon-level surface reduction only — the firewall is
# applied separately because it carries lock-out risk and needs an auto-rollback.
# Idempotent: safe to re-run. Every edited file is backed up next to itself.
#
# Deliberately NOT `set -e`. This touches four independent subsystems, and a board where avahi
# happens to be absent must still get its SSH and dnsmasq hardening — aborting on the first
# non-zero would silently skip the rest. The price of no `-e` is that every step has to report
# its own result, which the earlier version did not do: it printed "disabled+stopped" and
# "bind-dynamic added" unconditionally, so a run without root announced a hardened board that
# had not been touched at all. Each step now tracks RC and the script exits non-zero if any
# failed.
set -uo pipefail

[ "$(id -u)" = 0 ] || { echo "!! must run as root — try: sudo $0"; exit 1; }

RC=0

bak() { [ -f "$1" ] && cp -a "$1" "$1.bak-$(date +%Y%m%d-%H%M%S)"; }
say() { printf '\n=== %s ===\n' "$*"; }

# ── 1. SSH: key-only ─────────────────────────────────────────────────────────────────────────
# :22 is deliberately reachable from the LAN, and the `pi` account HAS a password, with no
# fail2ban and maxauthtries 6. Password auth is the single most valuable target on this board.
# Safe because /home/pi/.ssh/authorized_keys already holds the lenovoserver key we connect with.
say "1. SSH key-only"
# The guard below is the only thing standing between this script and a board on a wall with no
# way in. It used to fail exactly in the case it exists for: `grep -c .` on an EMPTY file prints
# "0" AND exits 1, so the `|| echo 0` fired too and KEYS became "0\n0"; `[ "0\n0" -lt 1 ]` then
# errors with "integer expected", returns 2, and the *else* branch runs — "safe to proceed",
# passwords disabled, zero keys. A missing file worked fine; only empty failed open. So: swallow
# the exit status, then insist the result is a plain number before comparing it. Counting only
# real key lines as well, because `grep -c .` also counts comments and a file of pure comments
# is not a way back in either.
#
# Comments are stripped FIRST and the key type is then matched anywhere on the line, because
# anchoring it to the start of the line misses every entry carrying options —
# `from="…",restrict ssh-ed25519 …` and `command="…" ssh-rsa …` are perfectly good keys, and a
# board whose only key is option-prefixed was refused outright. Dropping comment lines up front
# is what keeps a line like `# use ssh-ed25519 here` from counting as a way in.
KEYS=$(grep -vE '^[[:space:]]*(#|$)' /home/pi/.ssh/authorized_keys 2>/dev/null \
       | grep -cE '(^|[[:space:],])(ssh-|ecdsa-|sk-)' || true)
case "$KEYS" in ''|*[!0-9]*) KEYS=0 ;; esac
if [ "$KEYS" -lt 1 ]; then
  echo "  !! REFUSING: no usable key in authorized_keys — disabling passwords would lock everyone out"
  RC=1
else
  echo "  authorized_keys entries: $KEYS — safe to proceed"
  D=/etc/ssh/sshd_config.d/99-hardening.conf
  mkdir -p /etc/ssh/sshd_config.d
  cat > "$D" <<'EOF'
# Board is reachable on the house LAN since the wifi uplink was added. Key-only.
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
X11Forwarding no
EOF
  # `Include sshd_config.d/*` must actually be honoured, else this file is inert.
  if ! grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/\*' /etc/ssh/sshd_config; then
    echo "  !! sshd_config has no Include for sshd_config.d — applying inline instead"
    bak /etc/ssh/sshd_config
    sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
    grep -qE '^PasswordAuthentication no' /etc/ssh/sshd_config || echo "PasswordAuthentication no" >> /etc/ssh/sshd_config
  fi
  if sshd -t 2>/dev/null; then
    if systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null; then
      echo -n "  now: "; sshd -T | grep -iE '^passwordauthentication|^maxauthtries' | tr '\n' ' '; echo
    else
      echo "  !! sshd reload FAILED — the config is written but NOT live"; RC=1
    fi
  else
    echo "  !! sshd config test FAILED — not reloading"; sshd -t; RC=1
  fi
fi

# ── 2. apache2 ───────────────────────────────────────────────────────────────────────────────
# Tech4Sport's setup UI. Nothing depends on it: no reverse systemd dep, no reference to
# localhost:80 under /home/pi/ledbox, our bridge uses :8889 on loopback, and the AP already
# NAT-redirects :80 to our own console (ledbox-http-redirect). Its front page is a hard PHP
# fatal anyway. DISABLED, NOT DELETED — /home/pi/ledbox/www is left untouched so this is one
# command to undo: systemctl enable --now apache2
say "2. apache2 (vendor web admin)"
if systemctl is-enabled apache2 >/dev/null 2>&1 || systemctl is-active apache2 >/dev/null 2>&1; then
  if systemctl disable --now apache2; then
    echo "  disabled+stopped (files kept at /home/pi/ledbox/www)"
  else
    echo "  !! could not disable apache2 — it is STILL serving the vendor UI"; RC=1
  fi
else
  echo "  already disabled"
fi
echo -n "  is-active: "; systemctl is-active apache2 || true

# ── 3. dnsmasq ───────────────────────────────────────────────────────────────────────────────
# Config says interface=wlan0, but without a bind directive dnsmasq still listens on *:53 and
# will answer the house LAN as an open resolver. bind-dynamic (not bind-interfaces) because
# wlan0's IP is assigned late by wlan0-ap-ip.service — bind-interfaces would race and fail.
say "3. dnsmasq bound to the AP only"
C=/etc/dnsmasq.d/ledbox-bind.conf
if ! grep -rqE '^\s*bind-(dynamic|interfaces)' /etc/dnsmasq.conf /etc/dnsmasq.d/ 2>/dev/null; then
  echo "bind-dynamic" > "$C"
  if systemctl restart dnsmasq; then
    sleep 2
    echo "  bind-dynamic added"
  else
    echo "  !! dnsmasq restart FAILED — it is STILL answering the house LAN on *:53"; RC=1
  fi
else
  echo "  already bound"
fi
echo -n "  listening on: "; ss -ulnp 2>/dev/null | awk '/:53 /{print $5}' | tr '\n' ' '; echo
echo -n "  dnsmasq: "; systemctl is-active dnsmasq

# ── 4. avahi ─────────────────────────────────────────────────────────────────────────────────
# mDNS was advertising the board across the house LAN. Restricted to the AP rather than
# disabled, so tablet-side discovery on ledbox_C0270 keeps working.
say "4. avahi restricted to the AP interface"
A=/etc/avahi/avahi-daemon.conf
if [ -f "$A" ]; then
  if ! grep -qE '^allow-interfaces=wlan0' "$A"; then
    bak "$A"
    sed -i 's/^#\?allow-interfaces=.*/allow-interfaces=wlan0/' "$A"
    grep -qE '^allow-interfaces=' "$A" || sed -i '/^\[server\]/a allow-interfaces=wlan0' "$A"
    systemctl restart avahi-daemon || { echo "  !! avahi restart FAILED — still advertising on every interface"; RC=1; }
  fi
  grep -E '^allow-interfaces=' "$A" | sed 's/^/  /'
  echo -n "  avahi: "; systemctl is-active avahi-daemon
fi

say "RESULT — listening sockets now"
ss -tlnp 2>/dev/null | awk 'NR==1 || /LISTEN/' | sed 's/^/  /'

[ "$RC" = 0 ] || echo $'\n!! one or more steps FAILED — the board is only partly hardened (see !! above)'
exit "$RC"
