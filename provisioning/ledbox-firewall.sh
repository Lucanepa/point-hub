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
#
# Deliberately NOT `set -e`: bailing out half way would leave the chain flushed with the INPUT
# policy still at DROP from a previous run — default-deny with nothing allowed, on a board bolted
# to a wall. Every rule goes through `a` instead, and the DROP policy is only set once all of
# them landed.
set -uo pipefail

# -w 5: without it a single insert can lose the xtables lock to NetworkManager or tailscale at
# boot, fail, and (before this) still be followed by an unconditional `-P INPUT DROP` — the
# scorer's tablet silently loses the console with nothing in any log to say why.
IPT='/usr/sbin/iptables -w 5'
IP6='/usr/sbin/ip6tables -w 5'
CHAIN=LEDBOX-IN

# A COUNTER, not a 0/1 flag: build() decides whether to apply the DROP policy by comparing the
# count before and after its own rules, and with a flag the v6 pass could not tell "v4 already
# failed" from "I just failed" — it would sail past a failure of its own and set DROP anyway.
RC=0
# Record failures instead of letting them pass silently. Every rule that must be there goes
# through this; the best-effort cleanup of superseded rules below deliberately does not.
a() { "$@" || RC=$((RC + 1)); }

# xt_hashlimit is not guaranteed to be present; fall back to plain `limit` (global, not per-IP)
# rather than skipping the rate limit entirely.
#
# `iptables -m hashlimit -h` only proves the *userspace* extension is installed — it never asks
# the kernel. With xt_hashlimit missing, every insert failed one at a time while the script still
# printed "hashlimit: per-source-IP" and nothing was rate-limited at all. Probe by actually
# inserting the rule into a throwaway chain, which is the one answer that cannot lie.
#
# Probed ONCE PER FAMILY. A single v4-only probe whose answer was reused for the v6 build merely
# cost the v6 rate limit back when a failed insert was swallowed — but every rule now increments
# RC, so one wrong answer here makes build() force `-P INPUT ACCEPT` for the whole v6 family. The
# two families really can disagree: ip6t_hashlimit is a separate module from ipt_hashlimit.
probe_hashlimit() { # $1 = the iptables binary (with its args)
  local B="$1" ok=1
  modprobe xt_hashlimit 2>/dev/null || true
  $B -N LEDBOX-PROBE 2>/dev/null || true
  $B -F LEDBOX-PROBE 2>/dev/null || true
  $B -A LEDBOX-PROBE -p tcp --dport 1 -m conntrack --ctstate NEW \
    -m hashlimit --hashlimit-name lbprobe --hashlimit-mode srcip \
    --hashlimit-above 1/min -j DROP >/dev/null 2>&1 || ok=0
  $B -F LEDBOX-PROBE 2>/dev/null || true
  $B -X LEDBOX-PROBE 2>/dev/null || true
  [ "$ok" = 1 ]
}
if probe_hashlimit "$IPT"; then HAVE_HASHLIMIT4=1; else HAVE_HASHLIMIT4=0; fi
if probe_hashlimit "$IP6"; then HAVE_HASHLIMIT6=1; else HAVE_HASHLIMIT6=0; fi

# Emits the whole ruleset for one rate-limited port, ACCEPT included. The two branches need
# opposite shapes, and splitting them between callee and caller is exactly what got the fallback
# inverted: `-m limit ... -j RETURN` matches traffic that is UNDER the limit, so normal LAN
# traffic RETURNed out of the chain into the DROP policy while a flood exceeded the limit, fell
# through, and hit the caller's unconditional ACCEPT. Precisely backwards. hashlimit here matches
# what is ABOVE the rate (so it DROPs floods); plain limit matches what is under it (so it has to
# carry the ACCEPT itself). Unreachable until now only because the old probe always said yes.
ratelimit() { # $1=bin $2=iface $3=port $4=per-min $5=burst $6=name
  local bin="$1" ifc="$2" port="$3" rate="$4" burst="$5" name="$6"
  # Which family's probe answer applies — same test build() uses to set v6.
  local have=$HAVE_HASHLIMIT4
  [ "$bin" = "$IP6" ] && have=$HAVE_HASHLIMIT6
  if [ "$have" = 1 ]; then
    a $bin -A $CHAIN -i "$ifc" -p tcp --dport "$port" -m conntrack --ctstate NEW \
      -m hashlimit --hashlimit-name "$name" --hashlimit-mode srcip \
      --hashlimit-above "$rate/min" --hashlimit-burst "$burst" -j DROP
  else
    a $bin -A $CHAIN -i "$ifc" -p tcp --dport "$port" -m conntrack --ctstate NEW \
      -m limit --limit "$rate/min" --limit-burst "$burst" -j ACCEPT
    a $bin -A $CHAIN -i "$ifc" -p tcp --dport "$port" -m conntrack --ctstate NEW -j DROP
  fi
  a $bin -A $CHAIN -i "$ifc" -p tcp --dport "$port" -j ACCEPT
}

build() { # $1 = iptables or ip6tables
  local B="$1" v6=0
  local before=$RC
  [ "$B" = "$IP6" ] && v6=1

  $B -N $CHAIN 2>/dev/null || true
  a $B -F $CHAIN

  a $B -A $CHAIN -i lo -j ACCEPT
  a $B -A $CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  a $B -A $CHAIN -m conntrack --ctstate INVALID -j DROP
  a $B -A $CHAIN -i tailscale0 -j ACCEPT

  # IPv6 needs ICMPv6 unconditionally — neighbour discovery is not optional, and dropping it
  # breaks v6 connectivity in ways that look like random failures much later.
  if [ "$v6" = 1 ]; then
    a $B -A $CHAIN -p ipv6-icmp -j ACCEPT
    a $B -A $CHAIN -i wlan1 -p udp --dport 546 -j ACCEPT   # DHCPv6 client
  fi

  # ── wlan0: the AP. The console tablet is here. Deliberately NOT rate-limited: a scorer
  #    throttled mid-match is a worse outcome than anything this would prevent. Brute-force
  #    protection for the PIN belongs in the app, where it can be precise.
  a $B -A $CHAIN -i wlan0 -p tcp --dport 8890 -j ACCEPT     # console (:80 REDIRECTs to here)
  a $B -A $CHAIN -i wlan0 -p tcp --dport 22   -j ACCEPT     # key-only since hardening
  a $B -A $CHAIN -i wlan0 -p udp --dport 53   -j ACCEPT
  a $B -A $CHAIN -i wlan0 -p tcp --dport 53   -j ACCEPT
  [ "$v6" = 0 ] && a $B -A $CHAIN -i wlan0 -p udp --dport 67 -j ACCEPT   # DHCP server for clients
  [ "$v6" = 0 ] && a $B -A $CHAIN -i wlan0 -p icmp --icmp-type echo-request -j ACCEPT

  # ── eth0: the Pi link. Management path and the fallback default route.
  a $B -A $CHAIN -i eth0 -p tcp --dport 22   -j ACCEPT
  a $B -A $CHAIN -i eth0 -p tcp --dport 8890 -j ACCEPT
  [ "$v6" = 0 ] && a $B -A $CHAIN -i eth0 -p icmp --icmp-type echo-request -j ACCEPT

  # ── wlan1: the house LAN. Least trusted.
  #    udp/68 is NOT optional — without it the DHCP lease never renews and the uplink dies
  #    hours later, which would look like a wifi fault rather than a firewall one.
  [ "$v6" = 0 ] && a $B -A $CHAIN -i wlan1 -p udp --dport 68 -j ACCEPT
  a $B -A $CHAIN -i wlan1 -p udp --dport 41641 -j ACCEPT     # tailscale direct (else DERP relay)
  # ratelimit emits the port's own ACCEPT — see the note on the function.
  ratelimit "$B" wlan1 22   30  60  "lbssh${v6}"
  ratelimit "$B" wlan1 8890 120 240 "lbcon${v6}"
  [ "$v6" = 0 ] && a $B -A $CHAIN -i wlan1 -p icmp --icmp-type echo-request -m limit --limit 10/min -j ACCEPT

  # Anything not accepted above falls out of the chain and meets the INPUT policy (DROP).
  # :80, :8889, :12345 and :53-from-the-LAN are covered by that, not by explicit DROPs.

  # Drop the older, narrower rules this supersedes — idempotent, ignore if absent.
  $B -D INPUT -i wlan1 -p tcp -m multiport --dports 80,8889,12345 -j DROP 2>/dev/null || true
  $B -D INPUT -i wlan1 -p udp --dport 53 -j DROP 2>/dev/null || true
  $B -D INPUT -i wlan1 -p tcp --dport 53 -j DROP 2>/dev/null || true

  # Hook the chain in exactly once, and only ever append — see the note at the top about ts-input.
  $B -C INPUT -j $CHAIN 2>/dev/null || a $B -A INPUT -j $CHAIN

  # Default-deny goes on LAST, and only if every allow above actually landed. The chain was
  # flushed at the top of this function, so a DROP policy over a half-built chain is a board with
  # no console, no SSH and no tailscale — reachable only by ladder. If anything failed we force
  # the policy back OPEN instead: an unfirewalled board is recoverable during a match, a
  # locked-out one is not. build_twice() below gets one more go at it before that stands.
  if [ "$RC" = "$before" ]; then
    a $B -P INPUT DROP
  else
    echo "  !! rule setup failed — forcing INPUT policy to ACCEPT, no default-deny applied"
    $B -P INPUT ACCEPT || true
  fi
}

# ONE bounded retry per family before accepting the fall-open above. Falling open is still the
# final state — a locked-out board on a hall wall is unrecoverable and an unfirewalled one is not
# — but it must be much harder to reach than a single unlucky moment, because nothing else retries
# it: the unit is Type=oneshot, systemd forbids Restart= on oneshot, and the only place the
# failure shows is `systemctl status`, which nobody reads mid-match. `-w 5` on every call already
# handles most of the transient xtables-lock case; this covers the rest. build() is idempotent —
# it re-creates and re-flushes the chain and `-C`-guards the INPUT hook — so re-running it is safe,
# and a second pass that succeeds puts the DROP policy back on, undoing the first pass's ACCEPT.
FAILED=0
build_twice() { # $1 = iptables or ip6tables
  local B="$1" before=$RC
  build "$B"
  [ "$RC" = "$before" ] && return 0
  echo "  !! retrying once in 3s before leaving this family unfirewalled"
  sleep 3
  before=$RC
  build "$B"
  [ "$RC" = "$before" ] || FAILED=$((FAILED + 1))
}

build_twice "$IPT"
build_twice "$IP6"

hl() { [ "$1" = 1 ] && echo 'per-source-IP' || echo 'global fallback'; }
echo "  hashlimit: v4=$(hl "$HAVE_HASHLIMIT4") v6=$(hl "$HAVE_HASHLIMIT6")"
echo "  v4 INPUT policy: $($IPT -S INPUT | head -1)"
echo "  v6 INPUT policy: $($IP6 -S INPUT | head -1)"
echo "  rules in $CHAIN: v4=$($IPT -S $CHAIN | grep -c '^-A') v6=$($IP6 -S $CHAIN | grep -c '^-A')"
# Exit on the FINAL state, not on RC. RC counts every failed call including ones a retry then
# fixed, and a unit showing `failed` over a board that is in fact fully firewalled sends someone
# poking at netfilter during a match for no reason. The count is still reported either way.
[ "$RC" = 0 ] || echo "  !! $RC iptables call(s) failed in total — see above"
# Ask netfilter, do not infer. FAILED counts a failed `-P INPUT DROP` even when the policy was
# ALREADY DROP from the previous boot — in which case the board is correctly firewalled, and
# claiming otherwise shouts at every logged-in terminal and makes install-firewall.sh roll back a
# perfectly good ruleset. The only thing that settles it is the policy actually in the kernel.
OPEN=0
for B in "$IPT" "$IP6"; do
  case "$($B -S INPUT 2>/dev/null | head -1)" in
    *"-P INPUT DROP"*) ;;
    *) OPEN=$((OPEN + 1)) ;;
  esac
done
if [ "$OPEN" != 0 ]; then
  echo "  !! $OPEN address family/families left UNFIREWALLED (INPUT policy is not DROP)"
  exit 1
fi
[ "$FAILED" = 0 ] || echo "  note: $FAILED family/families needed a retry but ended up correctly firewalled"
exit 0
