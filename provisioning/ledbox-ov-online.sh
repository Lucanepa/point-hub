#!/bin/bash
# "OpenVolley online for devices on the board's Wi-Fi" — the C0270's one, narrow exception to
# "the board's own Wi-Fi has no internet" (ledbox-firewall.sh, lock-control-network.sh).
#
# OFF unless the owner turns it on (console ▸ Settings ▸ OpenVolley online, behind the scorer PIN).
# ON, a phone or tablet on the board's Wi-Fi (wlan0) reaches OpenVolley's servers and nothing else:
#   - dnsmasq answers *.openvolley.app (and Android's connectivitycheck.gstatic.com) by asking the
#     hall uplink's DNS server, and puts every address it answers with into one nft set; every other
#     name stays unresolved (no-resolv), so no DNS tunnel either;
#   - an nft table marks wlan0 -> wlan1 TCP/443 to an address in that set, and LEDBOX-FWD (the
#     firewall's forward drop) accepts that mark and the replies, ahead of its DROP; nothing else is
#     forwarded, IPv6 not at all (dnsmasq filters AAAA, the v6 forward drop is untouched);
#   - the board NATs those connections out of its uplink, so the tablet shares the board's public
#     address — which is what the cloud's /api/match/list keys a hall's own matches by.
#
# Installed at /usr/local/sbin/ledbox-ov-online by setup-ov-online.sh, root-owned. The bridge (user
# pi) asks for it through sudo, allowed for exactly `on`, `off` and `status` (/etc/sudoers.d/
# 030_ledbox-ov-online), so a PIN holder can switch it and can never widen it: the names, the port
# and the interfaces are fixed here, not passed in.
#
#   ledbox-ov-online on        turn it on (remembered across reboots), print the status
#   ledbox-ov-online off       turn it off and remove every piece, print the status
#   ledbox-ov-online status    one line of JSON: what is wanted and what is actually in place
#   ledbox-ov-online apply     make the board match what is wanted (boot: ledbox-ov-online.service)
#   ledbox-ov-online refresh   the uplink changed (NetworkManager dispatcher): new DNS server
#   ledbox-ov-online forward-rules   LEDBOX-FWD was rebuilt (ledbox-firewall.sh): its accepts again
#
# Refuses to turn on — and never turns kernel forwarding on — unless the firewall's forward drop is in
# place (FORWARD policy DROP, LEDBOX-FWD first and ending in DROP): with forwarding on and no drop,
# the board would route everything. OFF puts kernel forwarding back to what it was before.
#
# The commands it runs, and where it keeps things, can be moved for the tests (NFT, IPT, NMCLI, SYSCTL,
# SYSTEMCTL, DNSMASQ, LOGGER, OV_ONLINE_STATE_DIR, OV_ONLINE_DNS_DIR); interfaces and the subnet are
# read from /etc/default/ledbox-ov-online (OV_ONLINE_AP_IF, OV_ONLINE_UPLINK_IF, OV_ONLINE_SUBNET,
# OV_ONLINE_DNS to pin the upstream DNS server instead of asking NetworkManager).
set -uo pipefail

DEFAULTS=${OV_ONLINE_DEFAULTS:-/etc/default/ledbox-ov-online}
# shellcheck disable=SC1090
[ -r "$DEFAULTS" ] && . "$DEFAULTS"

NFT=${NFT:-/usr/sbin/nft}
IPT="${IPT:-/usr/sbin/iptables} -w 5"
NMCLI=${NMCLI:-nmcli}
SYSCTL=${SYSCTL:-/usr/sbin/sysctl}
SYSTEMCTL=${SYSTEMCTL:-systemctl}
DNSMASQ=${DNSMASQ:-/usr/sbin/dnsmasq}
LOGGER=${LOGGER:-logger}
STATE_DIR=${OV_ONLINE_STATE_DIR:-/var/lib/ledbox-ov-online}
DNS_DIR=${OV_ONLINE_DNS_DIR:-/etc/dnsmasq.d}
NOFWD_SYSCTL=${OV_ONLINE_NOFWD_SYSCTL:-/etc/sysctl.d/90-ledbox-no-forward.conf}

AP_IF=${OV_ONLINE_AP_IF:-wlan0}
UP_IF=${OV_ONLINE_UPLINK_IF:-wlan1}
SUBNET=${OV_ONLINE_SUBNET:-172.24.1.0/24}

# Fixed on purpose: what "OpenVolley online" lets through is decided here, not by a caller.
DOMAINS="openvolley.app connectivitycheck.gstatic.com"
TABLE=ovonline            # the same names the first, hand-applied opening used, so this takes it over
SET=ov4
MARK=0x77
TAG=ledbox-ov-online      # iptables comment on every rule of ours
FWD=LEDBOX-FWD
CONF="$DNS_DIR/zz-ledbox-ov-online.conf"
LEGACY_CONF="$DNS_DIR/zz-openvolley-online.conf"   # the hand-applied opening of 17.11.2026
STATE="$STATE_DIR/state"
FWD_BEFORE="$STATE_DIR/ip_forward.before"

IPV4_RE='^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$'

say() { echo "$*" >&2; }
note() { say "  $*"; $LOGGER -t ledbox-ov-online -- "$*" 2>/dev/null || true; }

valid_cfg() {
  case "$AP_IF$UP_IF" in *[!A-Za-z0-9_.-]*) return 1 ;; esac
  [[ "$SUBNET" =~ ^[0-9.]+/[0-9]{1,2}$ ]]
}

enabled() { [ "$(cat "$STATE" 2>/dev/null)" = on ]; }

# The firewall's forward drop, exactly as ledbox-firewall.sh builds it: FORWARD policy DROP, our
# chain first in FORWARD, and the chain's last rule a DROP. Anything else and we do not route.
fw_ready() {
  [ "$($IPT -S FORWARD 2>/dev/null | head -1)" = "-P FORWARD DROP" ] || return 1
  [ "$($IPT -S FORWARD 2>/dev/null | sed -n 2p)" = "-A FORWARD -j $FWD" ] || return 1
  [ "$($IPT -S $FWD 2>/dev/null | tail -1)" = "-A $FWD -j DROP" ]
}

# dnsmasq has to fill the nft set itself (nftset=, dnsmasq 2.87+ built with it).
nftset_ok() { $DNSMASQ --version 2>/dev/null | grep -Eq '(^|[[:space:]])nftset([[:space:]]|$)'; }

# The hall uplink's DNS server, from NetworkManager (or pinned in the defaults file). IPv4 only.
upstream() {
  local d=${OV_ONLINE_DNS:-}
  [ -n "$d" ] || d=$($NMCLI -t -f IP4.DNS dev show "$UP_IF" 2>/dev/null | head -1 | cut -d: -f2-)
  [[ "$d" =~ $IPV4_RE ]] && echo "$d"
}

# --- iptables: two accepts ahead of LEDBOX-FWD's DROP, one MASQUERADE --------------------------
R_OUT=(-i "$AP_IF" -o "$UP_IF" -s "$SUBNET" -m mark --mark "$MARK" -m comment --comment "$TAG" -j ACCEPT)
R_BACK=(-i "$UP_IF" -o "$AP_IF" -d "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "$TAG" -j ACCEPT)
R_NAT=(-s "$SUBNET" -o "$UP_IF" -m comment --comment "$TAG" -j MASQUERADE)
# The hand-applied opening's rules (no comment, no subnet): removed, never added.
L_OUT=(-i "$AP_IF" -o "$UP_IF" -m mark --mark "$MARK" -j ACCEPT)
L_BACK=(-i "$UP_IF" -o "$AP_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT)
L_NAT=(-s "$SUBNET" -o "$UP_IF" -j MASQUERADE)

has_fwd()  { $IPT -C $FWD "${R_OUT[@]}" 2>/dev/null && $IPT -C $FWD "${R_BACK[@]}" 2>/dev/null; }
has_nat()  { $IPT -t nat -C POSTROUTING "${R_NAT[@]}" 2>/dev/null; }

fwd_on() {
  local rc=0
  $IPT -C $FWD "${R_BACK[@]}" 2>/dev/null || $IPT -I $FWD 1 "${R_BACK[@]}" || rc=1
  $IPT -C $FWD "${R_OUT[@]}" 2>/dev/null || $IPT -I $FWD 1 "${R_OUT[@]}" || rc=1
  return $rc
}
fwd_off() {
  while $IPT -D $FWD "${R_OUT[@]}" 2>/dev/null; do :; done
  while $IPT -D $FWD "${R_BACK[@]}" 2>/dev/null; do :; done
}
nat_on()  { has_nat || $IPT -t nat -A POSTROUTING "${R_NAT[@]}"; }
nat_off() { while $IPT -t nat -D POSTROUTING "${R_NAT[@]}" 2>/dev/null; do :; done; }
# The hand-applied opening (its dnsmasq file is how it is recognised): its uncommented rules go, once.
# Only then — a vendor image may carry a MASQUERADE of the same shape, and that one is not ours.
legacy_off() {
  [ -f "$LEGACY_CONF" ] || return 0
  while $IPT -D $FWD "${L_OUT[@]}" 2>/dev/null; do :; done
  while $IPT -D $FWD "${L_BACK[@]}" 2>/dev/null; do :; done
  while $IPT -t nat -D POSTROUTING "${L_NAT[@]}" 2>/dev/null; do :; done
}

# --- nft: the set dnsmasq fills, and the mark ----------------------------------------------------
has_nft() { $NFT list table inet $TABLE >/dev/null 2>&1; }
nft_on() { # $1 = fresh: drop an existing table first (its set included)
  if has_nft; then
    [ "${1:-}" = fresh ] || return 0
    $NFT delete table inet $TABLE 2>/dev/null || true
  fi
  $NFT -f - <<NFT
table inet $TABLE {
  set $SET { type ipv4_addr; flags timeout; timeout 3h; }
  chain ovfw {
    type filter hook forward priority -10; policy accept;
    iifname "$AP_IF" oifname "$UP_IF" ip saddr $SUBNET ip daddr @$SET tcp dport 443 meta mark set $MARK
  }
}
NFT
}
nft_off() { ! has_nft || $NFT delete table inet $TABLE; }
set_size() { $NFT list set inet $TABLE $SET 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | sort -u | grep -c . || true; }

# --- kernel forwarding: on while ON, what it was before once OFF -----------------------------------
ipfwd() { $SYSCTL -n net.ipv4.ip_forward 2>/dev/null; }
ipfwd_on() {
  [ -f "$FWD_BEFORE" ] || ipfwd > "$FWD_BEFORE"
  [ "$(ipfwd)" = 1 ] || $SYSCTL -qw net.ipv4.ip_forward=1
}
ipfwd_off() {
  local before=""
  [ -f "$FWD_BEFORE" ] && before=$(cat "$FWD_BEFORE")
  # Not recorded (an older run, a lost file): lock-control-network.sh's file says what it should be.
  [ -n "$before" ] || { [ -f "$NOFWD_SYSCTL" ] && before=0; }
  case "$before" in 0|1) [ "$(ipfwd)" = "$before" ] || $SYSCTL -qw net.ipv4.ip_forward="$before" ;; esac
  rm -f "$FWD_BEFORE"
}

# --- dnsmasq: OpenVolley's names, and nothing else -------------------------------------------------
dns_text() { # $1 = upstream DNS server, may be empty
  echo "# ledbox-ov-online (provisioning/ledbox-ov-online.sh): OpenVolley online for devices on the"
  echo "# board's Wi-Fi. Only these names resolve for them, and every address in an answer goes into the"
  echo "# one set the forward rule allows (TCP 443). Removed again by: ledbox-ov-online off"
  local d
  for d in $DOMAINS; do
    [ -n "$1" ] && echo "server=/$d/$1"
    echo "nftset=/$d/4#inet#$TABLE#$SET"
  done
  echo "filter-AAAA"
}
has_dns() { [ -f "$CONF" ] && grep -q '^server=/openvolley.app/' "$CONF"; }
restart_dnsmasq() { $SYSTEMCTL restart dnsmasq >/dev/null 2>&1 || note "!! dnsmasq did not restart"; }
# Writes only when the text changed (a refresh with the same DNS server restarts nothing), checks it
# with dnsmasq --test and puts the old file back if dnsmasq would not take it.
dns_on() {
  local up="$1" tmp old="" changed=0
  tmp=$(mktemp) || return 1
  dns_text "$up" > "$tmp"
  if ! { [ -f "$CONF" ] && cmp -s "$tmp" "$CONF"; }; then
    [ -f "$CONF" ] && old=$(mktemp) && cp -p "$CONF" "$old"
    install -m 0644 "$tmp" "$CONF" || { rm -f "$tmp" "$old"; return 1; }
    changed=1
  fi
  rm -f "$tmp"
  [ -f "$LEGACY_CONF" ] && rm -f "$LEGACY_CONF" && changed=1
  [ "$changed" = 1 ] || return 0
  if ! $DNSMASQ --test >/dev/null 2>&1; then
    note "!! dnsmasq refused the OpenVolley-online file — put back what was there"
    if [ -n "$old" ]; then cp -p "$old" "$CONF"; else rm -f "$CONF"; fi
    rm -f "$old"
    restart_dnsmasq
    return 1
  fi
  rm -f "$old"
  restart_dnsmasq
}
dns_off() {
  local changed=0 f
  for f in "$CONF" "$LEGACY_CONF"; do [ -f "$f" ] && rm -f "$f" && changed=1; done
  [ "$changed" = 0 ] || restart_dnsmasq
}

# --- the whole thing --------------------------------------------------------------------------------
REASON=""
# Order: everything that only ACCEPTS marked packets first, kernel forwarding last.
apply_on() { # $1 = fresh (on) or "" (apply/refresh)
  valid_cfg || { REASON=bad-config; return 1; }
  fw_ready || { REASON=no-firewall; return 1; }
  nftset_ok || { REASON=no-nftset; return 1; }
  local up rc=0
  up=$(upstream || true)
  legacy_off
  [ -n "$up" ] || { REASON=no-uplink-dns; note "no DNS server on $UP_IF yet (no hall uplink?) — OpenVolley's names do not resolve until it has one"; }
  fwd_on || rc=1
  nat_on || rc=1
  nft_on "${1:-}" || rc=1
  dns_on "$up" || rc=1
  [ "$rc" = 0 ] || { REASON=${REASON:-apply-failed}; return 1; }
  ipfwd_on || { REASON=${REASON:-apply-failed}; return 1; }
  [ -n "$REASON" ] && return 1
  return 0
}
apply_off() {
  ipfwd_off
  legacy_off
  dns_off
  nft_off
  fwd_off
  nat_off
}
leftovers() { has_fwd || has_nat || has_nft || [ -f "$CONF" ] || [ -f "$LEGACY_CONF" ] || [ -f "$FWD_BEFORE" ]; }

status_json() {
  local en=false fw=false ns=false nft=false fwd=false nat=false dns=false ipf=false up n=0 active=false reason=""
  enabled && en=true
  fw_ready && fw=true
  nftset_ok && ns=true
  has_nft && nft=true && n=$(set_size)
  has_fwd && fwd=true
  has_nat && nat=true
  has_dns && dns=true
  [ "$(ipfwd)" = 1 ] && ipf=true
  up=$(upstream || true)
  if [ "$en" = true ]; then
    if [ "$nft$fwd$nat$dns$ipf" = truetruetruetruetrue ] && [ -n "$up" ] && [ "$fw" = true ]; then active=true
    elif [ "$fw" = false ]; then reason=no-firewall
    elif [ "$ns" = false ]; then reason=no-nftset
    elif [ -z "$up" ]; then reason=no-uplink-dns
    else reason=not-applied; fi
  elif leftovers; then reason=leftover
  fi
  printf '{"installed":true,"enabled":%s,"active":%s,"reason":%s,"firewall":%s,"nftset":%s,"upstream":%s,"addresses":%s,"pieces":{"nft":%s,"forward":%s,"nat":%s,"dns":%s,"ipForward":%s},"ap":"%s","uplink":"%s"}\n' \
    "$en" "$active" "$( [ -n "$reason" ] && printf '"%s"' "$reason" || echo null)" "$fw" "$ns" \
    "$( [ -n "$up" ] && printf '"%s"' "$up" || echo null)" "${n:-0}" "$nft" "$fwd" "$nat" "$dns" "$ipf" "$AP_IF" "$UP_IF"
}

CMD=${1:-status}
case "$CMD" in on|off|status|apply|refresh|forward-rules) ;; *) sed -n '2,32p' "$0" >&2; exit 2 ;; esac
[ "$(id -u)" = 0 ] || [ "${OV_ONLINE_ALLOW_NONROOT:-}" = 1 ] || { say "!! must run as root: sudo $0 $CMD"; exit 1; }

install -d -m 0755 "$STATE_DIR" 2>/dev/null || { say "!! cannot create $STATE_DIR"; exit 1; }
# One at a time: the bridge, the boot unit and the NetworkManager dispatcher can all call at once.
exec 9>"$STATE_DIR/.lock"
command -v flock >/dev/null 2>&1 && flock -w 30 9

case "$CMD" in
  on)
    if ! valid_cfg; then say "!! refused: bad interface or subnet in $DEFAULTS"; status_json; exit 3; fi
    if ! fw_ready; then
      note "refused to turn on: the firewall's forward drop is not in place (run install-firewall.sh, then --commit)"
      status_json; exit 3
    fi
    if ! nftset_ok; then note "refused to turn on: this dnsmasq cannot fill an nft set (needs 2.87+ with nftset)"; status_json; exit 4; fi
    echo on > "$STATE.new" && mv -f "$STATE.new" "$STATE"
    if apply_on fresh; then note "ON: devices on $AP_IF reach *.openvolley.app on 443 through $UP_IF, nothing else"
    else note "ON, not complete yet: $REASON"; fi
    status_json; exit 0 ;;
  off)
    echo off > "$STATE.new" && mv -f "$STATE.new" "$STATE"
    apply_off
    note "OFF: nothing from $AP_IF is forwarded"
    status_json; exit 0 ;;
  status)
    status_json; exit 0 ;;
  apply)
    if enabled; then
      if apply_on; then note "ON (boot): devices on $AP_IF reach *.openvolley.app on 443"; else note "ON, not complete: $REASON"; fi
    elif leftovers; then apply_off; note "OFF: removed what was left of an earlier opening"
    fi
    exit 0 ;;
  refresh)
    enabled || exit 0
    apply_on || note "refresh: $REASON"
    exit 0 ;;
  forward-rules)
    enabled || exit 0
    fw_ready || exit 0
    fwd_on || { note "!! could not put the OpenVolley-online accepts back into $FWD"; exit 1; }
    exit 0 ;;
esac
