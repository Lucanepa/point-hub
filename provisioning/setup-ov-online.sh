#!/bin/bash
# "OpenVolley online for devices on the board's Wi-Fi" on the C0270 — the switch's root side, so the
# owner can turn it on and off from the console (Settings ▸ OpenVolley online, behind the scorer PIN).
# Installing it turns nothing on: it stays OFF until someone switches it in the console.
#
#   sudo bash ledbox-bridge/provisioning/setup-ov-online.sh             # --check: read-only
#   sudo bash ledbox-bridge/provisioning/setup-ov-online.sh --apply
#   sudo bash ledbox-bridge/provisioning/setup-ov-online.sh --rollback  # off, then every file back out
#
# --apply installs (each backed up, lib-provision.sh; a re-run that finds them in place writes nothing):
#   1. /usr/local/sbin/ledbox-ov-online          the switch itself (ledbox-ov-online.sh, next to this)
#   2. ledbox-ov-online.service, enabled          puts it back at boot when ON, cleans up when OFF
#   3. /etc/NetworkManager/dispatcher.d/90-ledbox-ov-online
#                                                 a new hall network (new DNS server) → refresh
#   4. /etc/sudoers.d/030_ledbox-ov-online        the bridge (pi) may run exactly `ledbox-ov-online
#                                                 on|off|status` as root — nothing wider
# and says whether the INSTALLED firewall (/usr/local/sbin/ledbox-lan-guard.sh) knows about it: an
# older copy flushes the opening's accepts on every rebuild. Then: install-firewall.sh, --commit.
#
# What ON does, and why it is safe to offer behind the scorer PIN: ledbox-ov-online.sh's header.
# Not for the Point Hub DIY board (no Wi-Fi of its own): refused there.
LP_NAME=setup-ov-online
. "$(dirname "$(readlink -f "$0")")/lib-provision.sh" || { echo "!! lib-provision.sh missing"; exit 1; }

MODE=${1:---check}
case "$MODE" in --check|--apply|--rollback) ;; *) sed -n '2,22p' "$0"; exit 2 ;; esac
lp_need_root "$MODE"

HERE="$(dirname "$LP_SELF")"
OWNER=${OWNER:-pi}
HELPER=/usr/local/sbin/ledbox-ov-online
UNIT=ledbox-ov-online.service
UNIT_DST=/etc/systemd/system/$UNIT
HOOK=/etc/NetworkManager/dispatcher.d/90-ledbox-ov-online
SUDOERS=/etc/sudoers.d/030_ledbox-ov-online
FWSCRIPT=/usr/local/sbin/ledbox-lan-guard.sh
STATE_DIR=/var/lib/ledbox-ov-online

if [ "$MODE" = --rollback ]; then
  say "rollback"
  if [ -x "$HELPER" ]; then "$HELPER" off >/dev/null && echo "  turned off (every piece removed)"; fi
  systemctl disable "$UNIT" >/dev/null 2>&1 && echo "  $UNIT disabled"
  lp_restore; rc=$?
  systemctl daemon-reload
  rm -rf "$STATE_DIR"
  exit $rc
fi

hook_text() {
  cat <<'HOOK'
#!/bin/sh
# setup-ov-online.sh: when the hall uplink (wlan1) comes up or gets a new DNS server, OpenVolley online
# follows it (ledbox-ov-online refresh). Does nothing at all while the option is OFF.
case "$2" in
  up|dhcp4-change) [ "$1" = "wlan1" ] || exit 0 ;;
  dns-change) ;;
  *) exit 0 ;;
esac
[ -x /usr/local/sbin/ledbox-ov-online ] && exec /usr/local/sbin/ledbox-ov-online refresh
exit 0
HOOK
}
sudoers_text() {
  echo "# setup-ov-online.sh: the console's Settings ▸ OpenVolley online switch (the bridge runs as $OWNER)."
  echo "# Exactly these three commands; the helper decides what ON means, the caller cannot widen it."
  echo "$OWNER ALL=(root) NOPASSWD: $HELPER on, $HELPER off, $HELPER status"
}

say "preflight"
BLOCK=0
if systemctl cat pointhub-screen.service >/dev/null 2>&1; then
  echo "  !! this is a Point Hub board (pointhub-screen installed): it has no Wi-Fi of its own; not for here"
  BLOCK=1
fi
ip -o -4 addr show dev wlan0 2>/dev/null | grep -q 'inet ' && echo "  wlan0 (the board's Wi-Fi): $(ip -o -4 addr show dev wlan0 | awk '{print $4}')" \
  || { echo "  !! wlan0 has no address — no board Wi-Fi to open"; BLOCK=1; }
for f in ledbox-ov-online.sh "$UNIT"; do [ -r "$HERE/$f" ] || { echo "  !! no $HERE/$f"; BLOCK=1; }; done
command -v nft >/dev/null 2>&1 && echo "  nft: $(nft --version 2>/dev/null)" || { echo "  !! nft is not installed (apt install nftables)"; BLOCK=1; }
if dnsmasq --version 2>/dev/null | grep -Eq '(^|[[:space:]])nftset([[:space:]]|$)'; then echo "  dnsmasq: $(dnsmasq --version | head -1), fills nft sets"
else echo "  !! this dnsmasq cannot fill an nft set (needs 2.87+ built with nftset): ON would be refused"; BLOCK=1; fi
command -v visudo >/dev/null 2>&1 || { echo "  !! no visudo — cannot check the sudoers file"; BLOCK=1; }
if grep -q 'LEDBOX-FWD' "$FWSCRIPT" 2>/dev/null; then
  grep -q 'OV_ONLINE_HELPER' "$FWSCRIPT" && echo "  installed firewall knows OpenVolley online" \
    || echo "  installed firewall predates OpenVolley online: run install-firewall.sh (then --commit) after --apply"
else
  echo "  !! the installed firewall has no forward drop (LEDBOX-FWD): ON would be refused — install-firewall.sh first"
fi
for p in "$HELPER:$HERE/ledbox-ov-online.sh" "$UNIT_DST:$HERE/$UNIT"; do
  dst=${p%%:*} src=${p#*:}
  if [ ! -e "$dst" ]; then echo "  $dst: not installed"
  elif cmp -s "$dst" "$src"; then echo "  $dst: current"
  else echo "  $dst: differs from this checkout (--apply updates it)"; fi
done
[ -e "$HOOK" ] && echo "  $HOOK: present" || echo "  $HOOK: not installed"
[ -e "$SUDOERS" ] && { visudo -cf "$SUDOERS" >/dev/null 2>&1 && echo "  $SUDOERS: valid" || echo "  !! $SUDOERS: INVALID"; } || echo "  $SUDOERS: not installed"
echo "  $UNIT: $(systemctl is-enabled "$UNIT" 2>/dev/null || echo not installed)"
[ -x "$HELPER" ] && echo "  now: $("$HELPER" status 2>/dev/null)"
[ -f /etc/dnsmasq.d/zz-openvolley-online.conf ] && echo "  note: the hand-applied opening (ov-online.sh) is on this board; the switch takes it over (on) or removes it (off, or the next boot while OFF)"

if [ "$MODE" = --check ]; then
  [ "$BLOCK" = 0 ] && echo && echo "  ready: sudo bash $LP_SELF --apply"
  exit "$BLOCK"
fi
[ "$BLOCK" = 0 ] || { echo; echo "!! not applying (see above)"; exit 1; }

say "1) the switch: $HELPER"
lp_put "$HELPER" 0755 < "$HERE/ledbox-ov-online.sh"; [ $? = 1 ] && exit 1

say "2) at boot: $UNIT"
lp_put "$UNIT_DST" 0644 < "$HERE/$UNIT"; [ $? = 1 ] && exit 1
systemctl daemon-reload
# Enabled, NOT started now: with the option OFF (a fresh install) its apply removes every trace of an
# opening — including a hand-applied one somebody may be scoring through right now.
systemctl enable "$UNIT" >/dev/null 2>&1 && echo "  enabled (runs at the next boot)" || { echo "  !! could not enable $UNIT"; exit 1; }

say "3) a new hall network: $HOOK"
hook_text | lp_put "$HOOK" 0755; [ $? = 1 ] && exit 1

say "4) the bridge's sudo: $SUDOERS"
tmp=$(mktemp); sudoers_text > "$tmp"
if ! visudo -cf "$tmp" >/dev/null 2>&1; then rm -f "$tmp"; echo "  !! the sudoers text did not validate — nothing written"; exit 1; fi
lp_put "$SUDOERS" 0440 < "$tmp"; w=$?; rm -f "$tmp"; [ $w = 1 ] && exit 1
visudo -cf "$SUDOERS" >/dev/null 2>&1 || { echo "  !! $SUDOERS does not validate — rolling back"; lp_restore; exit 1; }

say "result"
echo "  now: $("$HELPER" status 2>/dev/null)"
grep -q 'OV_ONLINE_HELPER' "$FWSCRIPT" 2>/dev/null || cat <<NOTE
  The installed firewall predates OpenVolley online: every rebuild of it (a boot included) would
  flush the opening's accepts. Install the current one (auto-rollback in 240 s unless committed):
    sudo bash $HERE/install-firewall.sh
    sudo bash $HERE/install-firewall.sh --commit
NOTE
cat <<DONE

Done. OFF until switched: console ▸ Settings ▸ OpenVolley online (scorer PIN), or here:
  sudo $HELPER on | off | status
The console shows it within a few seconds; the bridge needs no restart.
DONE
