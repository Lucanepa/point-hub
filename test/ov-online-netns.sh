#!/bin/bash
# Run by ov-online-selftest.mjs inside `unshare -rn` (a private network namespace, as an ordinary
# user), like control-network-netns.sh: a fake C0270 with forwarding and NAT on, a phone on its
# Wi-Fi (wlan0) and "the internet" behind its uplink (wlan1). 8.8.8.8 plays an OpenVolley server
# (an address dnsmasq would have put into the set), 9.9.9.9 any other site. The real
# provisioning/ledbox-firewall.sh and provisioning/ledbox-ov-online.sh run against the real
# iptables and nft; only dnsmasq and systemctl are stand-ins (dnsmasq is not needed to route).
# Prints one line per check: "PASS ..." or "FAIL ...".
set -u
export PATH=/usr/sbin:/sbin:$PATH   # root's PATH on the board: lock-control-network.sh calls iptables, sysctl bare
HERE=$(cd "$(dirname "$0")" && pwd)
I=/usr/sbin/iptables
N=/usr/sbin/nft
T=$(mktemp -d)
mkdir -p "$T/bin" "$T/dns" "$T/state"
cat > "$T/bin/dnsmasq" <<'EOF'
#!/bin/sh
case "$1" in --version) echo "Dnsmasq version 2.90"; echo "Compile time options: IPv6 GNU-getopt DBus i18n IDN2 DHCP DHCPv6 no-Lua TFTP conntrack ipset nftset auth DNSSEC loop-detect inotify dumpfile" ;; esac
exit 0
EOF
chmod +x "$T/bin/dnsmasq"
export DNSMASQ="$T/bin/dnsmasq" SYSTEMCTL=true LOGGER=true NMCLI=false
export OV_ONLINE_STATE_DIR="$T/state" OV_ONLINE_DNS_DIR="$T/dns" OV_ONLINE_DEFAULTS=/nonexistent
export OV_ONLINE_DNS=10.9.9.2 OV_ONLINE_NOFWD_SYSCTL=/nonexistent
cp "$HERE/../provisioning/ledbox-ov-online.sh" "$T/bin/ledbox-ov-online"; chmod +x "$T/bin/ledbox-ov-online"
export OV_ONLINE_HELPER="$T/bin/ledbox-ov-online"
OV=$OV_ONLINE_HELPER
FW="$HERE/../provisioning/ledbox-firewall.sh"
LCN="$HERE/../provisioning/lock-control-network.sh"
printf 'interface=wlan0\nno-resolv\n' > "$T/dnsmasq.conf"
lcn() { DNSMASQ_MAIN="$T/dnsmasq.conf" DNSMASQ_DIR="$T/dns" LP_BACKUPS="$T/backups" bash "$LCN" --check 2>&1; }

ip link set lo up
unshare -n sleep 60 & PC=$!     # the phone on the board's Wi-Fi
unshare -n sleep 60 & PN=$!     # the internet behind the uplink
SRV=""
trap 'kill $PC $PN $SRV 2>/dev/null; rm -rf "$T"' EXIT
sleep 0.5
inns() { local p=$1; shift; nsenter -t "$p" -n --preserve-credentials "$@"; }
ip link add wlan0 type veth peer name phone0; ip link set phone0 netns $PC
ip link add wlan1 type veth peer name net0;   ip link set net0 netns $PN
ip addr add 172.24.1.1/24 dev wlan0; ip link set wlan0 up
ip addr add 10.9.9.1/24 dev wlan1;  ip link set wlan1 up; ip route add default via 10.9.9.2
inns $PC sh -c 'ip link set lo up; ip addr add 172.24.1.50/24 dev phone0; ip link set phone0 up; ip route add default via 172.24.1.1'
inns $PN sh -c 'ip link set lo up; ip addr add 10.9.9.2/24 dev net0; ip link set net0 up; ip addr add 8.8.8.8/32 dev lo; ip addr add 9.9.9.9/32 dev lo; ip route add default via 10.9.9.1'
# "The internet": answers on 443 and 80 and notes who connected (the NAT check).
inns $PN python3 -c '
import socket, threading, sys
log = open(sys.argv[1], "a", buffering=1)
def serve(port):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", port)); s.listen(16)
    while True:
        c, a = s.accept(); log.write("%s %d\n" % (a[0], port)); c.close()
def serve_udp(addr, port):  # one socket per address: from 0.0.0.0 the reply would leave from 10.9.9.2
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind((addr, port))
    while True:
        d, a = s.recvfrom(512); s.sendto(d, a)
for p in (443, 80): threading.Thread(target=serve, args=(p,), daemon=True).start()
for h in ("8.8.8.8", "9.9.9.9"):
    for p in (123, 53): threading.Thread(target=serve_udp, args=(h, p), daemon=True).start()
threading.Event().wait()
' "$T/peers" >/dev/null 2>&1 & SRV=$!
echo 1 > /proc/sys/net/ipv4/ip_forward
$I -t nat -A POSTROUTING -o wlan1 -j MASQUERADE         # the vendor's worst case
sleep 0.5

tcp() { inns $PC timeout 2 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1; }
udp() { inns $PC python3 -c 'import socket,sys; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(1); s.sendto(b"x",(sys.argv[1],int(sys.argv[2]))); s.recv(16)' "$1" "$2" >/dev/null 2>&1; }
chk() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fi; }
st() { "$OV" status 2>/dev/null; }

chk "the test is real: with no firewall the phone reaches any site" 'tcp 9.9.9.9 443'
chk "...and any UDP port (the UDP checks below are not empty)" 'udp 9.9.9.9 123 && udp 9.9.9.9 53'
# From here on the only NAT is ours (the MASQUERADE check below would pass on the vendor's otherwise).
$I -t nat -F POSTROUTING; : > "$T/peers"

# 1. Never without the forward drop.
"$OV" on >/dev/null 2>&1; rc=$?
chk "refused while the firewall's forward drop is not in place (exit $rc)" '[ $rc = 3 ]'
chk "...and nothing of it was set up" '! $N list table inet ovonline >/dev/null 2>&1 && [ "$(cat $T/state/state 2>/dev/null)" != on ]'

bash "$FW" >/dev/null 2>&1
chk "with the firewall: nothing gets out" '! tcp 9.9.9.9 443 && ! tcp 8.8.8.8 443'
chk "OFF (the default): the firewall added nothing of ours" '! $I -S LEDBOX-FWD | grep -q ledbox-ov-online'

# 2. ON.
fwd0=$(cat /proc/sys/net/ipv4/ip_forward)
echo 0 > /proc/sys/net/ipv4/ip_forward      # what lock-control-network.sh leaves
out=$("$OV" on 2>/dev/null); rc=$?
chk "on: exit 0 and active ($out)" '[ $rc = 0 ] && echo "$out" | grep -q "\"enabled\":true,\"active\":true"'
chk "kernel forwarding is on while ON" '[ "$(cat /proc/sys/net/ipv4/ip_forward)" = 1 ]'
chk "the dnsmasq file names only OpenVolley, the Android check and four time servers, upstream 10.9.9.2" \
  '[ "$(grep -c "^server=" $T/dns/zz-ledbox-ov-online.conf)" = 6 ] && grep -q "^server=/openvolley.app/10.9.9.2$" $T/dns/zz-ledbox-ov-online.conf && grep -q "^nftset=/openvolley.app/4#inet#ovonline#ov4$" $T/dns/zz-ledbox-ov-online.conf && grep -q "^filter-AAAA$" $T/dns/zz-ledbox-ov-online.conf'
chk "an address nobody resolved stays blocked" '! tcp 8.8.8.8 443'
$N add element inet ovonline ov4 '{ 8.8.8.8 }'     # what dnsmasq does for an OpenVolley answer
chk "an OpenVolley address gets through on 443" 'tcp 8.8.8.8 443'
chk "...NATed: the server sees the board's uplink address" '[ "$(cat $T/peers)" = "10.9.9.1 443" ]'
chk "...but not on 80" '! tcp 8.8.8.8 80'
chk "...and no ping" '! inns $PC ping -c1 -W1 8.8.8.8 >/dev/null 2>&1'
chk "any other site stays blocked" '! tcp 9.9.9.9 443'
chk "a time server nobody resolved stays blocked" '! udp 9.9.9.9 123'
$N add element inet ovonline ntp4 '{ 9.9.9.9 }'   # what dnsmasq does for a time-server answer
chk "a time-server address gets through on UDP 123" 'udp 9.9.9.9 123'
chk "...but not on another UDP port, nor on 443" '! udp 9.9.9.9 53 && ! tcp 9.9.9.9 443'
chk "an OpenVolley address is not let out on UDP 123" '! udp 8.8.8.8 123'
$N delete element inet ovonline ntp4 '{ 9.9.9.9 }'
# tailscaled starting after us puts its chain first in FORWARD (one that accepts out of tailscale0).
$I -N ts-forward; $I -A ts-forward -o tailscale0 -j ACCEPT; $I -I FORWARD 1 -j ts-forward
chk "tailscale's chain first: status says not active" '! st | grep -q "\"active\":true"'
"$OV" refresh >/dev/null 2>&1
chk "...a refresh puts LEDBOX-FWD back first, active, OpenVolley still reachable" '[ "$($I -S FORWARD | sed -n 2p)" = "-A FORWARD -j LEDBOX-FWD" ] && [ "$($I -S FORWARD | grep -c -- "-j LEDBOX-FWD")" = 1 ] && st | grep -q "\"active\":true" && tcp 8.8.8.8 443'
$I -D FORWARD -j ts-forward; $I -F ts-forward; $I -X ts-forward
chk "the phone still reaches the board" 'inns $PC ping -c1 -W1 172.24.1.1 >/dev/null 2>&1'
chk "IPv6 forwarding untouched: policy DROP, LEDBOX-FWD a lone DROP" '[ "$(/usr/sbin/ip6tables -S FORWARD | head -1)" = "-P FORWARD DROP" ] && [ "$(/usr/sbin/ip6tables -S LEDBOX-FWD | grep -c "^-A")" = 1 ]'
"$OV" on >/dev/null 2>&1
chk "on twice: each rule once" '[ "$($I -S LEDBOX-FWD | grep -c ledbox-ov-online)" = 2 ] && [ "$($I -t nat -S POSTROUTING | grep -c ledbox-ov-online)" = 1 ]'

# lock-control-network.sh --check while ON: the opening is named for what it is; anything else still flagged.
out=$(lcn)
chk "lock-control-network --check names OpenVolley online as ON" 'echo "$out" | grep -q "OpenVolley online: ON"'
chk "...its dnsmasq names as OpenVolley online's, not as forwarding upstream" 'echo "$out" | grep -q "and OpenVolley online.s: openvolley.app connectivitycheck.gstatic.com" && ! echo "$out" | grep -q "FORWARDS questions upstream"'
chk "...its two LEDBOX-FWD accepts, and nothing it cannot account for" 'echo "$out" | grep -q "LEDBOX-FWD: 2 accept" && ! echo "$out" | grep -q "neither its DROP"'
echo "server=/example.com/1.1.1.1" > "$T/dns/other.conf"
$I -I LEDBOX-FWD 1 -i wlan0 -j ACCEPT
out=$(lcn)
chk "...a server= line of somebody else's is still flagged" 'echo "$out" | grep -q "still asked upstream" && echo "$out" | grep -q "other.conf"'
chk "...and so is a forward accept that is not OpenVolley online's" 'echo "$out" | grep -q "neither its DROP nor OpenVolley online"'
echo "server=8.8.4.4" > "$T/dns/other.conf"
chk "...a plain server= line still means FORWARDS" 'lcn | grep -q "FORWARDS questions upstream"'
rm -f "$T/dns/other.conf"; $I -D LEDBOX-FWD -i wlan0 -j ACCEPT

# 3. The firewall rebuilt while ON (install-firewall.sh, a boot): the accepts come back by themselves.
$N add element inet ovonline ov4 '{ 8.8.8.8 }'
bash "$FW" >/dev/null 2>&1
chk "the firewall rebuilt while ON keeps OpenVolley reachable" 'tcp 8.8.8.8 443 && ! tcp 9.9.9.9 443'
chk "...with the DROP still last in LEDBOX-FWD" '[ "$($I -S LEDBOX-FWD | tail -1)" = "-A LEDBOX-FWD -j DROP" ]'

# 4. A reboot while ON: the kernel forgets the table, NAT and forwarding; the boot unit's apply puts them back.
$N delete table inet ovonline; $I -t nat -F POSTROUTING; echo 0 > /proc/sys/net/ipv4/ip_forward
bash "$FW" >/dev/null 2>&1
"$OV" apply >/dev/null 2>&1
$N add element inet ovonline ov4 '{ 8.8.8.8 }'
chk "after a reboot the boot unit puts it all back" 'tcp 8.8.8.8 443 && st | grep -q "\"active\":true"'

# 5. OFF removes every piece.
out=$("$OV" off 2>/dev/null)
chk "off: not enabled, nothing left ($out)" 'echo "$out" | grep -q "\"enabled\":false,\"active\":false,\"reason\":null"'
chk "off: OpenVolley blocked again" '! tcp 8.8.8.8 443'
chk "off: no nft table, no tagged rule, no NAT of ours, no dnsmasq file" \
  '! $N list table inet ovonline >/dev/null 2>&1 && ! $I -S | grep -q ledbox-ov-online && ! $I -t nat -S | grep -q ledbox-ov-online && [ ! -e $T/dns/zz-ledbox-ov-online.conf ]'
chk "off: LEDBOX-FWD is a lone DROP again" '[ "$($I -S LEDBOX-FWD | grep -c "^-A")" = 1 ]'
chk "off: kernel forwarding back to what it was before ON (0)" '[ "$(cat /proc/sys/net/ipv4/ip_forward)" = 0 ]'
out=$(lcn)
chk "lock-control-network --check: off, no forwarding warning, local names only" 'echo "$out" | grep -q "OpenVolley online: off" && ! echo "$out" | grep -q "^  !!" && echo "$out" | grep -q "answers only local names (no-resolv)$"'
bash "$FW" >/dev/null 2>&1; "$OV" apply >/dev/null 2>&1
chk "off survives a firewall rebuild and a boot apply" '! $I -S LEDBOX-FWD | grep -q ledbox-ov-online && ! $N list table inet ovonline >/dev/null 2>&1'

# 6. The hand-applied opening of 17.11 (ov-online.sh): taken over by on, gone with off.
echo "server=/openvolley.app/10.9.9.2" > $T/dns/zz-openvolley-online.conf
$N -f - <<NFT
table inet ovonline { set ov4 { type ipv4_addr; flags timeout; timeout 3h; }
  chain ovfw { type filter hook forward priority -10; policy accept; iifname "wlan0" oifname "wlan1" tcp dport 443 ip daddr @ov4 meta mark set 0x77; }; }
NFT
$I -I LEDBOX-FWD 1 -i wlan1 -o wlan0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$I -I LEDBOX-FWD 1 -i wlan0 -o wlan1 -m mark --mark 0x77 -j ACCEPT
$I -t nat -A POSTROUTING -s 172.24.1.0/24 -o wlan1 -j MASQUERADE
out=$("$OV" status 2>/dev/null)
chk "the hand-applied opening shows as a leftover while OFF" 'echo "$out" | grep -q "\"reason\":\"leftover\""'
"$OV" apply >/dev/null 2>&1
chk "the boot apply (OFF) removes it completely" '[ "$($I -S LEDBOX-FWD | grep -c "^-A")" = 1 ] && ! $N list table inet ovonline >/dev/null 2>&1 && [ ! -e $T/dns/zz-openvolley-online.conf ] && ! $I -t nat -S POSTROUTING | grep -q "172.24.1.0/24"'
echo "DONE"
