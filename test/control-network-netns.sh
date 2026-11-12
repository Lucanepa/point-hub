#!/bin/bash
# Run by control-network-selftest.mjs inside `unshare -rn` (a private network namespace, as an
# ordinary user). A fake board with the worst case a vendor image could have — forwarding on and NAT
# out of the uplink — a phone on its Wi-Fi (wlan0) and the internet behind its uplink (wlan1).
# Prints one line per check: "PASS ..." or "FAIL ...".
set -u
I=/usr/sbin/iptables
ip link set lo up
unshare -n sleep 30 & PC=$!     # the phone on the board's Wi-Fi
unshare -n sleep 30 & PN=$!     # the internet behind the uplink
trap 'kill $PC $PN 2>/dev/null' EXIT
sleep 0.5
inns() { local p=$1; shift; nsenter -t "$p" -n --preserve-credentials "$@"; }
ip link add wlan0 type veth peer name phone0; ip link set phone0 netns $PC
ip link add wlan1 type veth peer name net0;   ip link set net0 netns $PN
ip addr add 172.24.1.1/24 dev wlan0; ip link set wlan0 up
ip addr add 10.9.9.1/24 dev wlan1;  ip link set wlan1 up; ip route add default via 10.9.9.2
inns $PC sh -c 'ip link set lo up; ip addr add 172.24.1.50/24 dev phone0; ip link set phone0 up; ip route add default via 172.24.1.1'
inns $PN sh -c 'ip link set lo up; ip addr add 10.9.9.2/24 dev net0; ip link set net0 up; ip addr add 8.8.8.8/32 dev lo; ip route add default via 10.9.9.1'
echo 1 > /proc/sys/net/ipv4/ip_forward
$I -t nat -A POSTROUTING -o wlan1 -j MASQUERADE
# tailscale's own forward chain, there before ours on a real board
$I -N ts-forward; $I -A FORWARD -j ts-forward; $I -A ts-forward -j ACCEPT
phone_out() { inns $PC ping -c1 -W1 8.8.8.8 >/dev/null 2>&1; }
chk() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fi; }
chk "the test is real: without the firewall the phone reaches the internet" phone_out
bash "$(dirname "$0")/../provisioning/ledbox-firewall.sh" >/dev/null 2>&1
chk "with the firewall the phone cannot reach the internet" '! phone_out'
chk "the phone still reaches the board" 'inns $PC ping -c1 -W1 172.24.1.1 >/dev/null 2>&1'
chk "the board itself still reaches the internet" 'ping -c1 -W1 8.8.8.8 >/dev/null 2>&1'
chk "FORWARD policy is DROP (v4)" '[ "$($I -S FORWARD | head -1)" = "-P FORWARD DROP" ]'
chk "FORWARD policy is DROP (v6)" '[ "$(/usr/sbin/ip6tables -S FORWARD | head -1)" = "-P FORWARD DROP" ]'
chk "our drop comes before tailscale's ts-forward" '[ "$($I -S FORWARD | sed -n 2p)" = "-A FORWARD -j LEDBOX-FWD" ]'
bash "$(dirname "$0")/../provisioning/ledbox-firewall.sh" >/dev/null 2>&1
chk "a second run keeps exactly one hook, still first" '[ "$($I -S FORWARD | grep -c LEDBOX-FWD)" = 1 ] && [ "$($I -S FORWARD | sed -n 2p)" = "-A FORWARD -j LEDBOX-FWD" ]'
chk "still blocked after the second run" '! phone_out'
