#!/bin/bash
# LedBox board hardening, steps 1-4. Daemon-level surface reduction only — the firewall is
# applied separately because it carries lock-out risk and needs an auto-rollback.
# Idempotent: safe to re-run. Every edited file is backed up next to itself.
set -uo pipefail

bak() { [ -f "$1" ] && cp -a "$1" "$1.bak-$(date +%Y%m%d-%H%M%S)"; }
say() { printf '\n=== %s ===\n' "$*"; }

# ── 1. SSH: key-only ─────────────────────────────────────────────────────────────────────────
# :22 is deliberately reachable from the LAN, and the `pi` account HAS a password, with no
# fail2ban and maxauthtries 6. Password auth is the single most valuable target on this board.
# Safe because /home/pi/.ssh/authorized_keys already holds the lenovoserver key we connect with.
say "1. SSH key-only"
KEYS=$(grep -c . /home/pi/.ssh/authorized_keys 2>/dev/null || echo 0)
if [ "$KEYS" -lt 1 ]; then
  echo "  !! REFUSING: no authorized_keys — disabling passwords would lock everyone out"
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
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null
    echo -n "  now: "; sshd -T | grep -iE '^passwordauthentication|^maxauthtries' | tr '\n' ' '; echo
  else
    echo "  !! sshd config test FAILED — not reloading"; sshd -t
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
  systemctl disable --now apache2
  echo "  disabled+stopped (files kept at /home/pi/ledbox/www)"
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
  systemctl restart dnsmasq && sleep 2
  echo "  bind-dynamic added"
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
    systemctl restart avahi-daemon
  fi
  grep -E '^allow-interfaces=' "$A" | sed 's/^/  /'
  echo -n "  avahi: "; systemctl is-active avahi-daemon
fi

say "RESULT — listening sockets now"
ss -tlnp 2>/dev/null | awk 'NR==1 || /LISTEN/' | sed 's/^/  /'
