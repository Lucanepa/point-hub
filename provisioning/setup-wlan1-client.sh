#!/bin/bash
# Bring the Netgear A6210 (MT7612U, USB 0846:9053) up as a CLIENT on the LedBox board.
#
# Why: the board has no RTC and today reaches the internet only through the openvolley Pi
# (ledbox-nat.service). If the Pi is off, the board silently loses time and match history gets
# stamped wrong. Its own uplink removes that single point of failure.
#
# The built-in wlan0 keeps serving the ledbox_C0270 AP untouched — separate radio, and NM's
# unmanaged rule is per-interface (wlan0 only), so wlan1 is managed automatically.
#
# The passphrase is staged in a file so it never appears in a command line, in `ps`, or in shell
# history. Written straight into a 0600 NM keyfile, then shredded.
#
# Usage:
#   ./setup-wlan1-client.sh --check          # is the adapter enumerated?
#   ./setup-wlan1-client.sh --scan           # list visible networks on wlan1
#   ./setup-wlan1-client.sh --connect "SSID" # join (reads $PASSFILE)
#   ./setup-wlan1-client.sh --verify         # prove uplink + NTP work without the Pi
#   ./setup-wlan1-client.sh --hall ["SSID"]  # open hall Wi-Fi (default Free_WLAN_KTZH) + its DNS fix
#   ./setup-wlan1-client.sh --login ["SSID"] # hall Wi-Fi with a username + password (default SCHULEN_KTZH)
#   ./setup-wlan1-client.sh --forget-login   # remove that one again
#   ./setup-wlan1-client.sh --hotspot ["SSID"] # a volunteer's phone hotspot (default KSCW-Board), PSK asked
#   ./setup-wlan1-client.sh --forget-hotspot # remove that one again
set -uo pipefail

CON=ledbox-uplink
NM_DIR=${NM_DIR:-/etc/NetworkManager/system-connections}
KEYFILE=$NM_DIR/${CON}.nmconnection
# /run, not /tmp: tmpfs, cleared at reboot, and not the world-writable directory every other
# process on the board can also drop a file into. /tmp/wl1.txt is still honoured because that is
# what the staging one-liner said for a while and it is what fingers remember.
LEGACY_PASSFILE=/tmp/wl1.txt
if [ -n "${PASSFILE:-}" ]; then
  :                                                   # explicit override wins, always
elif [ ! -s /run/ledbox/wl1 ] && [ -s "$LEGACY_PASSFILE" ]; then
  PASSFILE=$LEGACY_PASSFILE
else
  PASSFILE=/run/ledbox/wl1
fi
# eth0 (via the Pi) sits at metric 100. 50 makes wifi win when present, and leaves the Pi as
# an automatic fallback rather than removing it.
METRIC=50

say() { printf '\n=== %s ===\n' "$*"; }

shred1() { [ -e "$1" ] || return 0; shred -u "$1" 2>/dev/null || rm -f "$1"; return 0; }
# Shreds the legacy copy too, not just the one we read. With a passphrase staged at BOTH paths —
# the exact state the README's /tmp -> /run migration leaves behind if the old file was never
# cleaned up — /run wins the selection above, so the /tmp copy survived --connect unshredded AND
# unmentioned, which is the whole failure mode staging in /run was meant to end.
shred_pass() { shred1 "$PASSFILE"; shred1 "$LEGACY_PASSFILE"; return 0; }

# GKeyFile un-escapes \\, \s, \n, \t and \r when NetworkManager reads the value back, and strips
# whitespace around the '='. Written raw, a passphrase containing a backslash silently becomes a
# DIFFERENT passphrase — and it surfaces as "wlan1 won't associate" long after the staged copy
# was shredded, with nothing left on the board to compare against.
kfesc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/^ /\\s/' -e 's/ $/\\s/'; }

check() {
  say "USB enumeration"
  if lsusb | grep -qi "0846:9053"; then
    echo "  OK  Netgear A6210 present:"
    lsusb | grep -i "0846:9053" | sed 's/^/      /'
  elif lsusb | grep -qiE "0846:|netgear"; then
    echo "  !!  A Netgear device is present but NOT in wifi mode (0846:9053):"
    lsusb | grep -iE "0846:|netgear" | sed 's/^/      /'
    echo "      -> this is the CD-ROM/storage mode; needs usb-modeswitch."
  else
    echo "  --  no Netgear adapter on the USB bus (not plugged in?)"
  fi

  say "wireless interfaces"
  ls /sys/class/net | tr '\n' ' '; echo
  if [ -d /sys/class/net/wlan1 ]; then
    echo "  OK  wlan1 exists -> $(readlink -f /sys/class/net/wlan1/device/driver | xargs basename 2>/dev/null || echo '?')"
  else
    echo "  --  wlan1 absent"
  fi

  say "driver / firmware"
  lsmod | grep -q mt76x2u && echo "  OK  mt76x2u loaded" || echo "  --  mt76x2u not loaded"
  ls /lib/firmware/mediatek/mt7662u.bin >/dev/null 2>&1 \
    && echo "  OK  mt7662u firmware present" || echo "  !!  mt7662u firmware MISSING"

  say "recent kernel messages"
  sudo dmesg | grep -iE "mt76|usb 1-|wlan1" | tail -12
}

scan() {
  [ -d /sys/class/net/wlan1 ] || { echo "!! wlan1 absent — plug the adapter in first"; exit 1; }
  sudo nmcli device wifi rescan ifname wlan1 2>/dev/null
  sleep 3
  say "visible networks on wlan1"
  nmcli -f SSID,CHAN,FREQ,SIGNAL,SECURITY device wifi list ifname wlan1 | head -25
}

connect() {
  # Armed before anything can exit. The staged PSK used to be shredded only on the success path,
  # so any of the four early exits below left the house wifi passphrase sitting in cleartext at a
  # fixed, world-readable-directory path until the next reboot — and the usual reason to hit one
  # of those exits is a typo, i.e. you re-run and never notice.
  trap 'shred_pass' EXIT

  local ssid="${1:-}"
  # key-mgmt: sae = WPA3-Personal, wpa-psk = WPA2. band: a = 5GHz, bg = 2.4GHz, "" = auto.
  local keymgmt="${2:-sae}"
  local band="${3:-a}"
  [ -n "$ssid" ]            || { echo "!! usage: $0 --connect \"SSID\" [sae|wpa-psk] [a|bg|auto]"; exit 1; }
  [ -d /sys/class/net/wlan1 ] || { echo "!! wlan1 absent — plug the adapter in first"; exit 1; }
  [ -s "$PASSFILE" ]        || { echo "!! no passphrase staged at $PASSFILE"; exit 1; }

  # Refuse to read a staging file we cannot vouch for. Wrong owner or loose mode means either the
  # PSK has already leaked, or someone else chose what we are about to write into the keyfile.
  local powner pmode
  powner=$(stat -c %U "$PASSFILE" 2>/dev/null || echo '?')
  pmode=$(stat -c %a "$PASSFILE" 2>/dev/null || echo '?')
  if [ "$powner" != "$(id -un)" ] && [ "$powner" != root ]; then
    echo "!! $PASSFILE is owned by '$powner', not you or root — refusing to read it"; exit 1
  fi
  case "$pmode" in
    600|400) ;;
    *) echo "!! $PASSFILE is mode $pmode, must be 0600 — treat that passphrase as leaked and rotate it"; exit 1 ;;
  esac

  local pass; pass=$(cat "$PASSFILE")
  if [ "${#pass}" -lt 8 ] || [ "${#pass}" -gt 63 ]; then
    echo "!! WPA passphrase must be 8-63 chars (got ${#pass})"; exit 1
  fi
  # A stray CR from a Windows-side copy/paste, or a tab, would be silently re-interpreted by
  # GKeyFile on the way back out. Reject rather than guess.
  #
  # [[:cntrl:]], NOT ![[:print:]]: the negated form also rejects every non-ASCII byte under the C
  # locale, and `ssh <board> 'cmd'` on a board with no generated locale runs in exactly that. A
  # house SSID with an umlaut was accepted from an interactive login and refused over plain ssh,
  # with a message blaming a control character that was not there. Non-ASCII round-trips through
  # kfesc() into a GLib.KeyFile byte-identically, so it was never the thing to guard against.
  case "$pass" in *[[:cntrl:]]*) echo "!! passphrase contains a control character (stray CR or tab?) — refusing"; exit 1 ;; esac
  case "$ssid" in *[[:cntrl:]]*) echo "!! SSID contains a control character — refusing"; exit 1 ;; esac
  echo "  SSID '$ssid', ${keymgmt}, band='${band:-auto}', passphrase ${#pass} chars (value never printed)"

  local ssid_esc pass_esc
  ssid_esc=$(kfesc "$ssid")
  pass_esc=$(kfesc "$pass")

  local bandline=""
  [ -n "$band" ] && [ "$band" != "auto" ] && bandline="band=$band"

  # Written as a keyfile rather than `nmcli ... wifi-sec.psk`, so the secret never lands in ps.
  sudo tee "$KEYFILE" >/dev/null <<EOF
[connection]
id=$CON
type=wifi
interface-name=wlan1
autoconnect=true
autoconnect-priority=10

[wifi]
mode=infrastructure
ssid=$ssid_esc
$bandline

[wifi-security]
key-mgmt=$keymgmt
psk=$pass_esc

[ipv4]
method=auto
route-metric=$METRIC

[ipv6]
method=auto
addr-gen-mode=default
route-metric=$METRIC
EOF
  sudo chown root:root "$KEYFILE"
  sudo chmod 600 "$KEYFILE"
  shred_pass
  echo "  keyfile written 0600, staging file shredded"

  sudo nmcli connection reload
  say "bringing up $CON"
  sudo nmcli connection up "$CON" ifname wlan1 || { echo "!! failed to come up"; exit 1; }
  sleep 4
  verify
}

# The hall's open Wi-Fi: Free_WLAN_KTZH at the KWI hall, a Swisscom Public WLAN with a Free-SMS
# login page (the console's Settings ▸ Hall internet does the login; src/hallLogin.js). Idempotent:
# creates the 'hall-uplink' connection the first time and brings every setting back to this on each
# later run, so re-running it is how you repair a board someone "fixed" by hand.
#
#   priority 5 / metric 60 — below the house network (ledbox-uplink: 10 / 50), so a board that can
#     see both prefers the one with no login page, and above the Pi's eth0 (100).
#   dns-options single-request-reopen,timeout:1,attempts:3 — the portal's resolver drops one of the
#     two queries glibc sends in parallel (A and AAAA, same socket), and the resolver then sits out
#     its full 5 s default timeout before retrying. Every lookup of the Directus host stalled 5 s,
#     which is more than livePush's 2 s request timeout: live scoring failed on every point while
#     `ping` worked fine. A fresh socket per query fixes the drop; timeout:1 caps any that remain.
#     See provisioning/README.md.
HALL_CON=hall-uplink
HALL_METRIC=60
hall() {
  local ssid="${1:-Free_WLAN_KTZH}"
  case "$ssid" in *[[:cntrl:]]*) echo "!! SSID contains a control character — refusing"; exit 1 ;; esac
  if nmcli -t -f NAME connection show | grep -qxF "$HALL_CON"; then
    echo "  '$HALL_CON' exists — bringing its settings back to these"
  else
    sudo nmcli connection add type wifi ifname wlan1 con-name "$HALL_CON" ssid "$ssid" >/dev/null \
      || { echo "!! could not create $HALL_CON"; exit 1; }
    echo "  '$HALL_CON' created"
  fi
  # An open network: drop any security block an earlier hand edit left behind (absent is fine).
  sudo nmcli connection modify "$HALL_CON" remove 802-11-wireless-security >/dev/null 2>&1 || true
  sudo nmcli connection modify "$HALL_CON" \
    connection.interface-name wlan1 \
    connection.autoconnect yes \
    connection.autoconnect-priority 5 \
    802-11-wireless.ssid "$ssid" \
    802-11-wireless.mode infrastructure \
    ipv4.method auto \
    ipv4.route-metric "$HALL_METRIC" \
    ipv4.dns-options "single-request-reopen,timeout:1,attempts:3" \
    ipv6.method auto \
    ipv6.route-metric "$HALL_METRIC" \
    || { echo "!! could not configure $HALL_CON"; exit 1; }
  echo "  SSID '$ssid', open, priority 5, metric $HALL_METRIC, dns-options single-request-reopen,timeout:1,attempts:3"

  # Settings only reach a live connection when it is brought up again.
  if nmcli -t -f NAME connection show --active | grep -qxF "$HALL_CON"; then
    say "re-applying to the active $HALL_CON"
    sudo nmcli connection up "$HALL_CON" ifname wlan1 >/dev/null || echo "!! could not re-apply (still configured; takes effect on the next connect)"
    sleep 3
    say "resolver options now in use"
    grep -E '^options' /etc/resolv.conf | sed 's/^/  /' || echo "  !! no options line in /etc/resolv.conf — is NetworkManager managing it?"
  else
    echo "  not connected now — joins by itself when '$ssid' is in range. Log in from the console: Settings ▸ Hall internet"
  fi
}

# A hall Wi-Fi that came with a username AND a password — at the KWI hall that is SCHULEN_KTZH, the
# canton's school network (LEUnet Schule, run by the Mittelschul- und Berufsbildungsamt). Its
# settings are from the MBA's own LEUnet handbook (V2.2, 11 Jul 2024, help.mba.zh.ch), section
# "Anmeldung SCHULEN_KTZH für Android":
#
#   WPA2-Enterprise, EAP-TTLS with PAP inside, server certificate from SwissSign Gold CA - G2 for
#   the domain ktzh.ch, username "vorname.nachname.schule" (e.g. …kwi), the Sek II intranet password.
#
# ONE attempt, never a guessing loop: the same handbook says wrong credentials, too many attempts
# and a password change each LOCK the account, for up to 8 hours. "One" needs two NM settings, not
# just one `nmcli connection up`: with a saved password NM does not stop at the first EAP failure,
# it waits out 802-1x.auth-timeout (25 s by default) while wpa_supplicant, 10 s after the reject,
# re-enables the network and sends the password AGAIN — and a profile that has connected before
# goes round that up to 1+3 times (connection.auth-retries). So auth-timeout=12 ends the attempt
# before that second exchange, auth-retries=1 bounds what a stale saved password costs per boot
# (~2 strikes; 0 would mean unlimited), and every --login deletes any earlier hall-login first,
# so a refusal takes NM's "never connected → ask for new secrets → none → fail" path. A script that tried methods and
# swapped username/password would lock it before the first serve. So for SCHULEN_KTZH everything
# is fixed, and the username is checked for the handbook's shape before anything is sent — a
# swapped pair is caught here, for free, instead of at the RADIUS server. Any other 802.1X network
# gets one attempt with METHOD= (eap:phase2, default peap:mschapv2) and DOMAIN=/CA= if known.
# WPA-Personal uses the password as passphrase. An open SSID is a web login page, which this cannot
# do — it stops rather than leave the board on a second portal it cannot get past.
#
# The certificate check is on for SCHULEN_KTZH and not optional: PAP sends the password itself
# inside the TLS tunnel, so whoever holds the other end of that tunnel reads it in clear. Without
# the check, any AP named SCHULEN_KTZH would collect the account. The CA is the system's copy of
# SwissSign Gold CA - G2, or the one shipped next to this script, and its fingerprint is checked
# either way. The board's clock matters for the same reason (no RTC; see the README).
#
#   - Its own NM connection 'hall-login', never ledbox-uplink (the house network) or hall-uplink.
#     Priority 8: above Free_WLAN_KTZH (5), so a board that sees both takes the one with no SMS
#     login, below the house (10). Metric 55. Same DNS options as hall-uplink — the same canton
#     network, very likely the same resolvers.
#   - 5 GHz when the SSID is seen there, for the reason ledbox-uplink pins band=a (the AP is 2.4).
#   - A failed attempt deletes the profile again: NM must not keep retrying a refused login on its
#     own (that is the lockout), and a dead profile at priority 8 would hold wlan1 away from
#     Free_WLAN_KTZH. hall-uplink is brought back and NM's own account is shown.
#   - When the account's password changes, run --forget-login at once: until then each boot still
#     presents the old password, ~2 strikes (auth-retries=1 above).
#
# The credentials come from $LOGINFILE (line 1 username, line 2 password, shredded on every exit)
# or, when that is absent, are asked for — the password IS echoed, so a typo is seen before it costs
# a strike; mind who is watching the screen. Run it as `ssh -t`.
# They go into a 0600 keyfile, never onto a command line.
#
# The attempt takes wlan1 down, so this refuses to run from a session carried by wlan1 (Tailscale
# over the hall Wi-Fi, say): it would cut itself off mid-way. Run it from a laptop on the board's
# own AP, or on the cable. FORCE=1 overrides that check, and only that one.
LOGIN_CON=hall-login
LOGIN_METRIC=55
LOGIN_PRIO=8
LOGIN_SSID_DEFAULT=SCHULEN_KTZH
LOGIN_KEYFILE=$NM_DIR/${LOGIN_CON}.nmconnection
LOGINFILE=${LOGINFILE:-/run/ledbox/login}
LOGIN_WAIT=${LOGIN_WAIT:-60}   # seconds for the attempt; a refused login fails well inside it
# SwissSign Gold CA - G2, the root the LEUnet handbook has every device install.
KTZH_CA_SHA256=62:DD:0B:E9:B9:F5:0A:16:3E:A0:F8:E7:5C:05:3B:1E:CA:57:EA:55:C8:68:8F:64:7C:68:81:F2:C8:35:7B:95
# The shipped copy first: Mozilla is retiring roots of Gold G2's age, and when Debian's
# ca-certificates follows, the system symlink disappears. Whichever is used is installed at a fixed
# root-owned path for the profile, so neither an apt upgrade nor a redeploy can pull it away later.
KTZH_CA_CANDIDATES="$(dirname "$(readlink -f "$0")")/swisssign-gold-ca-g2.pem /etc/ssl/certs/SwissSign_Gold_CA_-_G2.pem"
KTZH_CA_INSTALLED=${NM_DIR%/*}/certs/swisssign-gold-ca-g2.pem
LOGIN_AUTH_TIMEOUT=12   # s: a TTLS/PAP exchange takes 2-5; wpa_supplicant's re-try comes >= 12 s after the start

# How the board is being talked to right now: the interface the route back to the SSH client uses.
session_dev() {
  local client="${SSH_CONNECTION:-}"; client=${client%% *}
  [ -n "$client" ] || { echo local; return; }
  ip route get "$client" 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1
}

# The first candidate whose SHA-256 fingerprint is SwissSign Gold CA - G2's.
ktzh_ca() {
  local f fp
  for f in $KTZH_CA_CANDIDATES; do
    [ -r "$f" ] || continue
    fp=$(openssl x509 -in "$f" -noout -fingerprint -sha256 2>/dev/null | sed 's/.*=//')
    [ "$fp" = "$KTZH_CA_SHA256" ] && { echo "$f"; return 0; }
  done
  return 1
}

# Writes the hall-login keyfile with autoconnect OFF — switched on only once the login has worked,
# so NM never fires a refused one on its own. $1 = wpa-eap|wpa-psk|sae, then for wpa-eap:
# eap phase2 identity password [ca-file domain]; for the personal ones: psk.
write_login_keyfile() {
  local km="$1"; shift
  local sec
  if [ "$km" = wpa-eap ]; then
    local ca=""
    [ -n "${5:-}" ] && ca="ca-cert=$5"
    [ -n "${6:-}" ] && ca="$ca
domain-suffix-match=$(kfesc "$6")"
    sec="[wifi-security]
key-mgmt=wpa-eap

[802-1x]
eap=$1;
phase2-auth=$2
auth-timeout=$LOGIN_AUTH_TIMEOUT
identity=$(kfesc "$3")
password=$(kfesc "$4")
$ca"
  else
    sec="[wifi-security]
key-mgmt=$km
psk=$(kfesc "$1")"
  fi
  # umask 077 in the writing shell: `sudo tee` would create it 0644 until the chmod below.
  sudo sh -c 'umask 077; exec cat > "$1"' sh "$LOGIN_KEYFILE" <<EOF
[connection]
id=$LOGIN_CON
type=wifi
interface-name=wlan1
autoconnect=false
autoconnect-priority=$LOGIN_PRIO
auth-retries=1

[wifi]
mode=infrastructure
ssid=$LOGIN_SSID_ESC
$LOGIN_BANDLINE

$sec

[ipv4]
method=auto
route-metric=$LOGIN_METRIC

[ipv6]
method=auto
addr-gen-mode=default
route-metric=$LOGIN_METRIC
EOF
  sudo chown root:root "$LOGIN_KEYFILE"
  sudo chmod 600 "$LOGIN_KEYFILE"
  sudo nmcli connection reload
  # Not a secret, so nmcli is fine here — and it spares guessing keyfile list syntax.
  sudo nmcli connection modify "$LOGIN_CON" ipv4.dns-options "single-request-reopen,timeout:1,attempts:3" >/dev/null
}

login() {
  # Ctrl-C or a dropped session while NM is still trying must not leave a half-tried profile
  # behind: NM carries on after nmcli dies. LOGIN_PENDING spans write → confirmed success.
  LOGIN_PENDING=0
  # The device autoconnect is given back on every exit: the `device disconnect` below blocks it, and
  # a board left like that after a typo would sit off every network until the next reboot.
  trap '[ "$LOGIN_PENDING" = 1 ] && sudo nmcli connection delete "$LOGIN_CON" >/dev/null 2>&1; sudo nmcli device set wlan1 autoconnect yes >/dev/null 2>&1; shred1 "$LOGINFILE"' EXIT
  trap 'exit 130' INT TERM HUP
  local ssid="${1:-$LOGIN_SSID_DEFAULT}"
  [ -d /sys/class/net/wlan1 ] || { echo "!! wlan1 absent — plug the adapter in first"; exit 1; }
  case "$ssid" in *[[:cntrl:]]*) echo "!! SSID contains a control character — refusing"; exit 1 ;; esac

  local dev; dev=$(session_dev)
  case "$dev" in
    local|wlan0|eth0) ;;
    *) if [ "${FORCE:-0}" != 1 ]; then
         echo "!! this SSH session runs over '$dev', which goes out through wlan1 — the attempt would"
         echo "   cut it mid-way. Connect a laptop to the board's own AP (or the cable) and run it"
         echo "   from there. FORCE=1 to do it anyway."
         exit 1
       fi ;;
  esac

  # What the network is and how to log in to it — fixed for SCHULEN_KTZH, from the environment
  # for anything else.
  local method domain ca=""
  if [ "$ssid" = SCHULEN_KTZH ]; then
    method=ttls:pap; domain=ktzh.ch
    ca=$(ktzh_ca) || { echo "!! SwissSign Gold CA - G2 not found (neither the system's nor the one shipped"
                       echo "   with this script) — without it the password would go to any AP. Deploy again."; exit 1; }
    sudo install -D -m 0644 "$ca" "$KTZH_CA_INSTALLED" && sudo chown root:root "$KTZH_CA_INSTALLED" \
      || { echo "!! could not install the CA at $KTZH_CA_INSTALLED"; exit 1; }
    ca=$KTZH_CA_INSTALLED
  else
    method=${METHOD:-peap:mschapv2}; domain=${DOMAIN:-}; ca=${CA:-}
    [ -n "$domain" ] && [ -z "$ca" ] && ca=/etc/ssl/certs/ca-certificates.crt
  fi

  # Quiet wlan1 first. hall-uplink autoconnects to Free_WLAN_KTZH, gets no DHCP lease, fails and
  # starts over every ~20 s; each round holds a scan, so wpa_supplicant rejected every scan the
  # attempt needed ("Reject scan trigger since one is already pending") and NM gave up with
  # ssid-not-found (23.10, KWI). Disconnected, the same attempt went through first time.
  sudo nmcli device disconnect wlan1 >/dev/null 2>&1
  sudo nmcli device wifi rescan ifname wlan1 2>/dev/null
  sleep 4
  # SECURITY and FREQ first and SSID last, unescaped: the first two never hold a ':', so whatever
  # follows the second one is the SSID verbatim, colons and all.
  local list; list=$(nmcli -t -e no -f SECURITY,FREQ,SSID device wifi list ifname wlan1 2>/dev/null)
  local rows; rows=$(printf '%s\n' "$list" | awk -F: -v s="$ssid" '{ x=$0; sub(/^[^:]*:[^:]*:/, "", x); if (x == s) print }')
  if [ -z "$rows" ]; then
    echo "!! '$ssid' is not in range of wlan1. What it can see:"
    nmcli -f SSID,SECURITY,CHAN,SIGNAL device wifi list ifname wlan1 | head -25
    exit 1
  fi
  local secs; secs=$(printf '%s\n' "$rows" | cut -d: -f1 | sort -u | tr '\n' '|')
  LOGIN_BANDLINE=""
  if printf '%s\n' "$rows" | cut -d: -f2 | grep -qE '^5[0-9]{3}'; then
    LOGIN_BANDLINE="band=a"
  fi
  LOGIN_SSID_ESC=$(kfesc "$ssid")
  echo "  '$ssid': security ${secs%|}, $([ -n "$LOGIN_BANDLINE" ] && echo "on 5 GHz — pinned" || echo "2.4 GHz only — shares the air with the board's AP")"

  local kind
  case "$secs" in
    *802.1X*)           kind=eap ;;
    *WPA2*|*WPA1*)      kind=wpa-psk ;;   # WPA2/WPA3 transition networks accept WPA2
    *WPA3*)             kind=sae ;;
    *)
      echo "!! '$ssid' is an OPEN network: the username and password go into a web login page."
      echo "   The board cannot do that one yet. On a phone or laptop, join it, open any http:// page,"
      echo "   and record the login (browser dev tools ▸ Network ▸ Save all as HAR) — like Free_WLAN_KTZH."
      exit 1 ;;
  esac
  [ "$ssid" = SCHULEN_KTZH ] && [ "$kind" != eap ] && {
    echo "!! SCHULEN_KTZH is not 802.1X here (${secs%|}) — not the network the handbook describes; stopping"; exit 1; }

  # The board has no RTC. A clock far off fails the server certificate's dates — harmless for the
  # account (the TLS tunnel fails before the password is sent), but the login fails all the same.
  # The year alone is not enough: on 23.10 the board booted at 02.10 (its last shutdown) and passed.
  # This script's own mtime is a floor — it cannot have been deployed in the future.
  if [ "$kind" = eap ] && [ -n "$ca" ] \
     && { [ "$(date +%Y)" -lt 2026 ] || [ "$(date +%s)" -lt "$(stat -c %Y "$0" 2>/dev/null || echo 0)" ]; }; then
    echo "!! the board's clock says $(date) — fix it first (the console sets it: open it on the tablet)"
    echo "   or from the laptop: ssh pi@172.24.1.1 \"sudo date -u -s '\$(date -u +%Y-%m-%dT%H:%M:%S)'\""; exit 1
  fi

  # The credentials: the staged file, else ask.
  local user pass
  if [ -s "$LOGINFILE" ]; then
    local owner mode
    owner=$(stat -c %U "$LOGINFILE" 2>/dev/null || echo '?'); mode=$(stat -c %a "$LOGINFILE" 2>/dev/null || echo '?')
    { [ "$owner" = "$(id -un)" ] || [ "$owner" = root ]; } || { echo "!! $LOGINFILE is owned by '$owner' — refusing"; exit 1; }
    case "$mode" in 600|400) ;; *) echo "!! $LOGINFILE is mode $mode, must be 0600 — refusing"; exit 1 ;; esac
    { IFS= read -r user; IFS= read -r pass; } < "$LOGINFILE"
    echo "  credentials from $LOGINFILE"
  elif [ -t 0 ]; then
    [ "$ssid" = SCHULEN_KTZH ] && echo "  username looks like vorname.nachname.kwi; password is the Sek II intranet one"
    IFS= read -r -p "  username: " user
    # Echoed on purpose: a typo here costs a strike, and seeing it before Enter is the cheap check.
    IFS= read -r -p "  password (shown as you type): " pass
  else
    echo "!! nothing staged at $LOGINFILE and no terminal to ask on — use: ssh -t <board> ..."; exit 1
  fi
  user=${user%$'\r'}; pass=${pass%$'\r'}
  [ "$kind" = eap ] && [ -z "$user" ] && { echo "!! need a username"; exit 1; }
  [ -n "$pass" ] || { echo "!! need a password"; exit 1; }
  case "$user$pass" in *[[:cntrl:]]*) echo "!! a control character in the credentials (stray tab?) — refusing"; exit 1 ;; esac

  # SCHULEN_KTZH usernames are "first.last.school", no spaces. Checked HERE, where a mistake costs
  # nothing — at the RADIUS server it costs a strike towards the lockout. Matched under LC_ALL=C so
  # the answer does not depend on the locale the laptop's ssh forwards; capitals pass (the
  # directory behind it is case-insensitive) and are sent as typed. A swapped pair has no override:
  # it would send the password as the EAP identity, which travels OUTSIDE the tunnel, in clear.
  if [ "$ssid" = SCHULEN_KTZH ]; then
    local shape='^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\.[A-Za-z]+$' ok_user=0 ok_pass=0
    ( LC_ALL=C; [[ "$user" =~ $shape ]] ) && ok_user=1
    ( LC_ALL=C; [[ "$pass" =~ $shape ]] ) && ok_pass=1
    if [ "$ok_user" = 0 ] && [ "$ok_pass" = 1 ]; then
      echo "!! the PASSWORD has the shape of a username (first.last.school) and the username does not —"
      echo "   they look swapped. Nothing was sent. Run again with them the other way round."
      exit 1
    fi
    if [ "$ok_user" = 0 ] && [ "${ODD_USERNAME:-0}" != 1 ]; then
      echo "!! that username is not shaped like a SCHULEN_KTZH one (first.last.school, e.g. …kwi)."
      case "$user" in *[![:ascii:]]*) echo "   It has a non-ASCII letter — school logins usually spell ü as ue, é as e." ;; esac
      echo "   Nothing was sent. ODD_USERNAME=1 to send it anyway (a wrong one counts towards the lockout)."
      exit 1
    fi
  fi

  local label
  if [ "$kind" = eap ]; then
    label="${method%%:*}/${method#*:} as '$user'"
    [ -n "$ca" ] && label="$label, server cert ${domain:+*.$domain }from $(basename "$ca")"
    [ -z "$ca" ] && label="$label, server cert NOT checked"
    sudo nmcli connection delete "$LOGIN_CON" >/dev/null 2>&1; sudo rm -f "$LOGIN_KEYFILE"
    LOGIN_PENDING=1
    write_login_keyfile wpa-eap "${method%%:*}" "${method#*:}" "$user" "$pass" "$ca" "$domain"
  else
    if [ "${#pass}" -lt 8 ] || [ "${#pass}" -gt 63 ]; then
      echo "!! a WPA passphrase is 8-63 chars; the password is ${#pass}"; exit 1
    fi
    label="$kind with the password as passphrase"
    sudo nmcli connection delete "$LOGIN_CON" >/dev/null 2>&1; sudo rm -f "$LOGIN_KEYFILE"
    LOGIN_PENDING=1
    write_login_keyfile "$kind" "$pass"
  fi
  shred1 "$LOGINFILE"

  say "logging in to '$ssid' — one attempt, up to ${LOGIN_WAIT}s"
  echo "  $label"
  local since; since=$(date '+%Y-%m-%d %H:%M:%S')
  if ! sudo nmcli --wait "$LOGIN_WAIT" connection up "$LOGIN_CON" ifname wlan1 >/dev/null 2>&1; then
    sudo nmcli connection delete "$LOGIN_CON" >/dev/null 2>&1 || sudo rm -f "$LOGIN_KEYFILE"
    LOGIN_PENDING=0
    # wpa_supplicant's own unit too: only it says whether the password reached the server
    # (EAP-FAILURE = a strike) or the TLS check stopped it first (CERT-ERROR = nothing was sent).
    local jl; jl=$(sudo journalctl -u NetworkManager -u wpa_supplicant --since "$since" --no-pager 2>/dev/null \
      | grep -iE "wlan1|$LOGIN_CON|802-1x|eap|supplicant|secrets|cert|TEMP-DISABLED|auth_failures")
    say "refused — what NetworkManager and wpa_supplicant said"
    printf '%s\n' "$jl" | tail -25 | sed 's/^/  /'
    echo "  '$LOGIN_CON' removed again — NM will not retry it on its own"
    local strikes; strikes=$(printf '%s\n' "$jl" | grep -c 'CTRL-EVENT-EAP-FAILURE')
    local nothing_sent=0
    if printf '%s\n' "$jl" | grep -qiE 'TLS-CERT-ERROR|Domain suffix mismatch|certificate verify'; then
      echo "  >> the SERVER CERTIFICATE was refused — the password was NOT sent. Safe to fix and retry."
      nothing_sent=1
    elif [ "$strikes" -gt 0 ]; then
      echo "  >> the server REFUSED the credentials ($strikes time(s) — each one counts towards the lockout)."
    elif ! printf '%s\n' "$jl" | grep -q 'CTRL-EVENT-EAP-STARTED'; then
      echo "  >> it never reached the access point (no EAP started) — the password was NOT sent. Safe to retry;"
      echo "     if it says ssid-not-found again, replug the Netgear stick or move it nearer the access point."
      nothing_sent=1
    fi
    if nmcli -t -f NAME connection show | grep -qxF "$HALL_CON"; then
      sudo nmcli connection up "$HALL_CON" ifname wlan1 >/dev/null 2>&1 && echo "  back on $HALL_CON"
    fi
    [ "$kind" = eap ] && [ "$nothing_sent" = 0 ] && echo "  !! read the log above before trying again: repeated refusals lock the account for up to 8 h"
    exit 1
  fi

  sudo nmcli connection modify "$LOGIN_CON" connection.autoconnect yes >/dev/null
  LOGIN_PENDING=0
  say "connected"
  echo "  saved as '$LOGIN_CON' (priority $LOGIN_PRIO, metric $LOGIN_METRIC) — rejoins by itself, also after a reboot"
  echo "  if this account's password ever changes: --forget-login straight away (each boot would cost ~2 strikes)"
  sleep 3
  verify
  exit 0   # verify's last grep finds nothing on a board without timedatectl's NTP lines — still a success
}

forget_login() {
  if sudo nmcli connection delete "$LOGIN_CON" >/dev/null 2>&1; then
    echo "  '$LOGIN_CON' deleted"
  else
    echo "  no '$LOGIN_CON' connection"
  fi
}

# Any volunteer's phone hotspot as the board's uplink, with no SSH and no board setup on the day
# (research product-03). The profile is written once, ahead of time; on the day a volunteer renames
# their phone's hotspot to KSCW-Board with the passphrase on the hall card, switches it on, and the
# board has internet — live scoring, the match-log upload, NTP and the tailnet.
#
#   - Saved as its own NM connection 'phone-hotspot'. Priority 6: ABOVE Free_WLAN_KTZH (hall-uplink,
#     5), because a hotspot somebody deliberately switched on should beat a hall network stuck
#     behind its SMS login page; BELOW the school login (hall-login, 8) and the house (10). Metric 58.
#   - NO band pin, unlike every other profile here. Many Android hotspots are 2.4 GHz only, and an
#     iPhone's is 5 GHz unless "Maximize Compatibility" is on — either must work. On 2.4 GHz it
#     shares the air with the board's AP, which is acceptable for a fallback.
#   - WPA2 (wpa-psk). A phone set to WPA3-only will not be joined; WPA2 or WPA2/WPA3 is fine.
#   - The passphrase is semi-public (it is on the hall card). Acceptable: the board is only a CLIENT
#     here and everything it sends is HTTPS or WireGuard, so a fake 'KSCW-Board' could only deny
#     service or see metadata. It is asked for (not echoed — use ssh -t) or read from $HOTFILE
#     (/run/ledbox/hotspot, 0600, shredded on every exit), and only ever written into a 0600
#     keyfile. Never into this repo.
#   - NetworkManager does not drop a WORKING connection for a higher-priority one that appears later.
#     A board already on Free_WLAN_KTZH takes the hotspot at its next (re)connect, not at once:
#     `sudo nmcli connection up phone-hotspot` (or a power cycle) when it matters.
#   - The console tablet must NOT be the phone giving the hotspot: it stays on the board's own AP.
#   - Idempotent: a re-run with the same passphrase writes nothing; with a new one it replaces the
#     keyfile (the old one is kept, 0600, under /var/backups/ledbox/). Undo: --forget-hotspot.
HOT_CON=phone-hotspot
HOT_SSID_DEFAULT=KSCW-Board
HOT_PRIO=6
HOT_METRIC=58
HOT_KEYFILE=$NM_DIR/${HOT_CON}.nmconnection
HOTFILE=${HOTFILE:-/run/ledbox/hotspot}
hotspot() {
  trap 'shred1 "$HOTFILE"' EXIT
  local ssid="${1:-$HOT_SSID_DEFAULT}"
  case "$ssid" in *[[:cntrl:]]*) echo "!! SSID contains a control character — refusing"; exit 1 ;; esac
  local pass
  if [ -s "$HOTFILE" ]; then
    local owner mode
    owner=$(stat -c %U "$HOTFILE" 2>/dev/null || echo '?'); mode=$(stat -c %a "$HOTFILE" 2>/dev/null || echo '?')
    { [ "$owner" = "$(id -un)" ] || [ "$owner" = root ]; } || { echo "!! $HOTFILE is owned by '$owner' — refusing"; exit 1; }
    case "$mode" in 600|400) ;; *) echo "!! $HOTFILE is mode $mode, must be 0600 — refusing"; exit 1 ;; esac
    IFS= read -r pass < "$HOTFILE"
    echo "  passphrase from $HOTFILE"
  elif [ -t 0 ]; then
    IFS= read -r -s -p "  passphrase for '$ssid' (as printed on the hall card): " pass; echo
  else
    echo "!! nothing staged at $HOTFILE and no terminal to ask on — use: ssh -t <board> ..."; exit 1
  fi
  pass=${pass%$'\r'}
  if [ "${#pass}" -lt 8 ] || [ "${#pass}" -gt 63 ]; then echo "!! a WPA passphrase is 8-63 chars (got ${#pass})"; exit 1; fi
  case "$pass" in *[[:cntrl:]]*) echo "!! passphrase contains a control character — refusing"; exit 1 ;; esac

  local body
  body="[connection]
id=$HOT_CON
type=wifi
interface-name=wlan1
autoconnect=true
autoconnect-priority=$HOT_PRIO

[wifi]
mode=infrastructure
ssid=$(kfesc "$ssid")

[wifi-security]
key-mgmt=wpa-psk
psk=$(kfesc "$pass")

[ipv4]
method=auto
route-metric=$HOT_METRIC

[ipv6]
method=auto
addr-gen-mode=default
route-metric=$HOT_METRIC"
  pass=""
  if sudo test -f "$HOT_KEYFILE" && [ "$(sudo cat "$HOT_KEYFILE")" = "$body" ]; then
    echo "  '$HOT_CON' already saved with exactly these settings — nothing written"
  else
    if sudo test -f "$HOT_KEYFILE"; then
      local bk; bk=/var/backups/ledbox/setup-wlan1-client-$(date +%Y%m%d-%H%M%S)
      sudo install -d -m 0700 /var/backups/ledbox "$bk" && sudo cp -a "$HOT_KEYFILE" "$bk/" \
        || { echo "!! could not back up the existing $HOT_KEYFILE — not replacing it"; exit 1; }
      echo "  previous profile kept at $bk/"
    fi
    printf '%s\n' "$body" | sudo sh -c 'umask 077; exec cat > "$1"' sh "$HOT_KEYFILE" || { echo "!! could not write $HOT_KEYFILE"; exit 1; }
    sudo chown root:root "$HOT_KEYFILE"; sudo chmod 600 "$HOT_KEYFILE"
    sudo nmcli connection reload || { echo "!! nmcli reload failed"; exit 1; }
    echo "  saved '$HOT_CON': SSID '$ssid', WPA2, any band, priority $HOT_PRIO, metric $HOT_METRIC (keyfile 0600)"
  fi
  body=""
  shred1 "$HOTFILE"
  nmcli -t -f NAME,AUTOCONNECT-PRIORITY connection show 2>/dev/null | grep -E "^(ledbox-uplink|hall-login|$HOT_CON|hall-uplink):" \
    | sort -t: -k2 -nr | sed 's/^/  order: /'
  echo "  not brought up now. When the phone's hotspot is on, it joins by itself — at once if wlan1 is idle,"
  echo "  else at its next reconnect:  sudo nmcli connection up $HOT_CON"
}

forget_hotspot() {
  if sudo nmcli connection delete "$HOT_CON" >/dev/null 2>&1; then
    echo "  '$HOT_CON' deleted"
  else
    echo "  no '$HOT_CON' connection"
  fi
}

verify() {
  say "wlan1 state"
  nmcli -f GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS,IP4.GATEWAY device show wlan1 2>/dev/null \
    | sed 's/^/  /'

  say "AP still up on wlan0? (must be unaffected)"
  printf '  hostapd: %s\n' "$(systemctl is-active hostapd)"
  printf '  wlan0:   %s\n' "$(ip -4 -o addr show wlan0 | awk '{print $4}')"
  # `iw` is not installed on this board — use hostapd's own control interface instead.
  if command -v hostapd_cli >/dev/null 2>&1; then
    printf '  clients: %s associated\n' "$(sudo hostapd_cli -i wlan0 list_sta 2>/dev/null | grep -cE '^([0-9a-f]{2}:){5}')"
  else
    printf '  clients: %s in ARP table\n' "$(ip neigh show dev wlan0 2>/dev/null | grep -c REACHABLE)"
  fi
  printf '  band:    %s\n' "$(nmcli -f ACTIVE,SSID,CHAN,FREQ device wifi list ifname wlan1 2>/dev/null | awk '/^yes/{print $(NF-1), $NF}')"

  say "routing (lower metric wins)"
  ip route | grep -E "^default" | sed 's/^/  /'

  say "internet over wlan1 specifically"
  if ping -c2 -W3 -I wlan1 1.1.1.1 >/dev/null 2>&1; then
    echo "  OK  wlan1 has its own route to the internet — no longer dependent on the Pi"
  else
    echo "  !!  no internet via wlan1"
  fi

  say "clock"
  date
  timedatectl 2>/dev/null | grep -E "synchronized|NTP service" | sed 's/^/  /'
}

# The read-only modes deliberately WARN rather than shred: staging the passphrase and then
# running --scan to pick the right SSID and key-mgmt is a normal sequence, and silently deleting
# the operator's staged secret half way through it would just mean staging it twice. Only
# connect() takes ownership of the file, and it shreds on every exit path.
case "${1:---check}" in
  --check|--scan|--verify)
    # Both paths, not only the one --connect would read: when a copy exists at /run AND at the
    # legacy /tmp path, /run wins and the /tmp one went unmentioned here as well as unshredded.
    [ -s "$PASSFILE" ] && echo "!! note: a staged passphrase is still sitting at $PASSFILE — --connect shreds it, nothing else does"
    [ "$PASSFILE" = "$LEGACY_PASSFILE" ] || [ ! -s "$LEGACY_PASSFILE" ] \
      || echo "!! note: an OLD staged passphrase is also at $LEGACY_PASSFILE — --connect shreds that too"
    ;;
esac

case "${1:---check}" in
  --check)   check ;;
  --scan)    scan ;;
  --connect) connect "${2:-}" "${3:-sae}" "${4:-a}" ;;
  --verify)  verify ;;
  --hall)    hall "${2:-}" ;;
  --login)   login "${2:-}" ;;
  --forget-login) forget_login ;;
  --hotspot) hotspot "${2:-}" ;;
  --forget-hotspot) forget_hotspot ;;
  *) echo "usage: $0 [--check|--scan|--connect \"SSID\" [sae|wpa-psk] [a|bg|auto]|--verify|--hall [\"SSID\"]|--login [\"SSID\"]|--forget-login|--hotspot [\"SSID\"]|--forget-hotspot]"; exit 1 ;;
esac
