#!/bin/bash
# LedBox board firewall — default-deny INPUT with per-interface allows.
#
# Installed at /usr/local/sbin/ledbox-lan-guard.sh and run by ledbox-lan-guard.service at boot.
# Replaces the earlier version, which only DROPped a few ports on wlan1.
#
# Trust model, least- to most-trusted:
#   wlan1  house LAN     — least trusted, rate-limited, only :22 and :8890
#   eth0   link to the Pi — management + fallback default route
#   wlan0  the board's own AP — the console tablet lives here; MUST NOT BREAK
#   lo     the bridge reaches the panel at LEDBOX_HOST=127.0.0.1:8889 through here
#
# Everything is built in a private LEDBOX-IN chain. INPUT itself is only ever *appended* to,
# never flushed, because tailscale owns `-j ts-input` there and re-adds it on its own schedule —
# an iptables-restore of the whole filter table would silently delete tailscale's rules.
set -uo pipefail

IPT=/usr/sbin/iptables
IP6=/usr/sbin/ip6tables
CHAIN=LEDBOX-IN

# xt_hashlimit is not guaranteed to be present; fall back to plain `limit` (global, not per-IP)
# rather than skipping the rate limit entirely.
if $IPT -m hashlimit -h >/dev/null 2>&1; then HAVE_HASHLIMIT=1; else HAVE_HASHLIMIT=0; fi

ratelimit() { # $1=bin $2=iface $3=port $4=per-min $5=burst $6=name
  local bin="$1" ifc="$2" port="$3" rate="$4" burst="$5" name="$6"
  if [ "$HAVE_HASHLIMIT" = 1 ]; then
    $bin -A $CHAIN -i "$ifc" -p tcp --dport "$port" -m conntrack --ctstate NEW \
      -m hashlimit --hashlimit-name "$name" --hashlimit-mode srcip \
      --hashlimit-above "$rate/min" --hashlimit-burst "$burst" -j DROP
  else
    $bin -A $CHAIN -i "$ifc" -p tcp --dport "$port" -m conntrack --ctstate NEW \
      -m limit --limit "$rate/min" --limit-burst "$burst" -j RETURN
  fi
}

build() { # $1 = iptables or ip6tables
  local B="$1" v6=0
  [ "$B" = "$IP6" ] && v6=1

  $B -N $CHAIN 2>/dev/null || true
  $B -F $CHAIN

  $B -A $CHAIN -i lo -j ACCEPT
  $B -A $CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  $B -A $CHAIN -m conntrack --ctstate INVALID -j DROP
  $B -A $CHAIN -i tailscale0 -j ACCEPT

  # IPv6 needs ICMPv6 unconditionally — neighbour discovery is not optional, and dropping it
  # breaks v6 connectivity in ways that look like random failures much later.
  if [ "$v6" = 1 ]; then
    $B -A $CHAIN -p ipv6-icmp -j ACCEPT
    $B -A $CHAIN -i wlan1 -p udp --dport 546 -j ACCEPT   # DHCPv6 client
  fi

  # ── wlan0: the AP. The console tablet is here. Deliberately NOT rate-limited: a scorer
  #    throttled mid-match is a worse outcome than anything this would prevent. Brute-force
  #    protection for the PIN belongs in the app, where it can be precise.
  $B -A $CHAIN -i wlan0 -p tcp --dport 8890 -j ACCEPT     # console (:80 REDIRECTs to here)
  $B -A $CHAIN -i wlan0 -p tcp --dport 22   -j ACCEPT     # key-only since hardening
  $B -A $CHAIN -i wlan0 -p udp --dport 53   -j ACCEPT
  $B -A $CHAIN -i wlan0 -p tcp --dport 53   -j ACCEPT
  [ "$v6" = 0 ] && $B -A $CHAIN -i wlan0 -p udp --dport 67 -j ACCEPT   # DHCP server for clients
  [ "$v6" = 0 ] && $B -A $CHAIN -i wlan0 -p icmp --icmp-type echo-request -j ACCEPT

  # ── eth0: the Pi link. Management path and the fallback default route.
  $B -A $CHAIN -i eth0 -p tcp --dport 22   -j ACCEPT
  $B -A $CHAIN -i eth0 -p tcp --dport 8890 -j ACCEPT
  [ "$v6" = 0 ] && $B -A $CHAIN -i eth0 -p icmp --icmp-type echo-request -j ACCEPT

  # ── wlan1: the house LAN. Least trusted.
  #    udp/68 is NOT optional — without it the DHCP lease never renews and the uplink dies
  #    hours later, which would look like a wifi fault rather than a firewall one.
  [ "$v6" = 0 ] && $B -A $CHAIN -i wlan1 -p udp --dport 68 -j ACCEPT
  $B -A $CHAIN -i wlan1 -p udp --dport 41641 -j ACCEPT     # tailscale direct (else DERP relay)
  ratelimit "$B" wlan1 22   30  60  "lbssh${v6}"
  $B -A $CHAIN -i wlan1 -p tcp --dport 22   -j ACCEPT
  ratelimit "$B" wlan1 8890 120 240 "lbcon${v6}"
  $B -A $CHAIN -i wlan1 -p tcp --dport 8890 -j ACCEPT
  [ "$v6" = 0 ] && $B -A $CHAIN -i wlan1 -p icmp --icmp-type echo-request -m limit --limit 10/min -j ACCEPT

  # Anything not accepted above falls out of the chain and meets the INPUT policy (DROP).
  # :80, :8889, :12345 and :53-from-the-LAN are covered by that, not by explicit DROPs.

  # Drop the older, narrower rules this supersedes — idempotent, ignore if absent.
  $B -D INPUT -i wlan1 -p tcp -m multiport --dports 80,8889,12345 -j DROP 2>/dev/null || true
  $B -D INPUT -i wlan1 -p udp --dport 53 -j DROP 2>/dev/null || true
  $B -D INPUT -i wlan1 -p tcp --dport 53 -j DROP 2>/dev/null || true

  # Hook the chain in exactly once, and only ever append — see the note at the top about ts-input.
  $B -C INPUT -j $CHAIN 2>/dev/null || $B -A INPUT -j $CHAIN
  $B -P INPUT DROP
}

build "$IPT"
build "$IP6"

echo "  hashlimit: $([ "$HAVE_HASHLIMIT" = 1 ] && echo 'per-source-IP' || echo 'global fallback')"
echo "  v4 INPUT policy: $($IPT -S INPUT | head -1)"
echo "  v6 INPUT policy: $($IP6 -S INPUT | head -1)"
echo "  rules in $CHAIN: v4=$($IPT -S $CHAIN | grep -c '^-A') v6=$($IP6 -S $CHAIN | grep -c '^-A')"
