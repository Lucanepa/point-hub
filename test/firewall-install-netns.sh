#!/bin/bash
# Run by firewall-install-selftest.mjs inside `unshare -rn` (a private network namespace, as an
# ordinary user). A fake C0270 with tailscale's own chains (ts-input / ts-forward / ts-postrouting,
# as tailscaled puts them in iptables mode), its uplink wlan1 to "the internet" with a DERP server on
# TCP 443, its Wi-Fi wlan0 with a phone, its cable eth0 with a laptop, and a tailscale0 to a tailnet
# peer. Long-lived sessions run the whole time — the board's DERP connection out of wlan1 and an
# SSH-style session in over tailscale0, on the cable and on the AP — while the real
# provisioning/install-firewall.sh applies, rolls back and commits the real ledbox-firewall.sh,
# starting from the firewall a board had committed before (OLD_FW, default the current one).
# Only systemctl, systemd-run, logger and dnsmasq are stand-ins.
# Prints one line per check: "PASS ..." or "FAIL ...", then DONE.
set -u
export PATH=/usr/sbin:/sbin:$PATH
HERE=$(cd "$(dirname "$0")" && pwd)
I=/usr/sbin/iptables
I6=/usr/sbin/ip6tables
N=/usr/sbin/nft
FW="$HERE/../provisioning/ledbox-firewall.sh"
INSTALL="$HERE/../provisioning/install-firewall.sh"
OLD_FW=${OLD_FW:-$FW}
T=$(mktemp -d)
mkdir -p "$T/bin" "$T/state" "$T/units" "$T/sbin" "$T/stub" "$T/dns" "$T/ovstate" "$T/out"
PIDS=""
trap 'kill $PIDS 2>/dev/null; rm -rf "$T"' EXIT

# ── stand-ins ───────────────────────────────────────────────────────────────────────────────────
cat > "$T/bin/systemctl" <<'EOF'
#!/bin/bash
S=$STUB; echo "systemctl $*" >> "$S/calls"
cmd=$1; shift; q=0; [ "${1:-}" = --quiet ] && { q=1; shift; }
case "$cmd" in
  is-enabled) s=$(cat "$S/enabled" 2>/dev/null || echo disabled); [ $q = 1 ] || echo "$s"; [ "$s" = enabled ] ;;
  enable) echo enabled > "$S/enabled" ;;
  disable) echo disabled > "$S/enabled" ;;
  is-active) if [ "${1:-}" = ledbox-fw-rollback.timer ]; then [ -f "$S/timer" ]; else [ $q = 1 ] || echo active; fi ;;
  stop) for u; do [ "$u" = ledbox-fw-rollback.timer ] && rm -f "$S/timer"; done; exit 0 ;;
  list-timers) [ -f "$S/timer" ] && echo "armed ledbox-fw-rollback.timer"; exit 0 ;;
  *) exit 0 ;;
esac
EOF
cat > "$T/bin/systemd-run" <<'EOF'
#!/bin/bash
echo "$*" > "$STUB/run.args"; touch "$STUB/timer"
EOF
cat > "$T/bin/dnsmasq" <<'EOF'
#!/bin/sh
case "$1" in --version) echo "Dnsmasq version 2.90"; echo "Compile time options: IPv6 nftset" ;; esac
exit 0
EOF
chmod +x "$T/bin/"*
export STUB="$T/stub"
export SYSTEMCTL="$T/bin/systemctl" SYSTEMD_RUN="$T/bin/systemd-run" LOGGER=true JOURNALCTL=true TAILSCALE=/nonexistent
export LEDBOX_FW_STATE_DIR="$T/state" LEDBOX_FW_TARGET="$T/sbin/ledbox-lan-guard.sh" LEDBOX_FW_UNIT_DIR="$T/units"
# OpenVolley online's switch, as setup-ov-online.sh installs it (OFF), so the firewall's forward-rules call is real.
cp "$HERE/../provisioning/ledbox-ov-online.sh" "$T/bin/ledbox-ov-online"; chmod +x "$T/bin/ledbox-ov-online"
touch "$T/no-forward.conf"
export OV_ONLINE_HELPER="$T/bin/ledbox-ov-online" DNSMASQ="$T/bin/dnsmasq" NMCLI=false
export OV_ONLINE_STATE_DIR="$T/ovstate" OV_ONLINE_DNS_DIR="$T/dns" OV_ONLINE_DEFAULTS=/nonexistent
export OV_ONLINE_DNS=10.9.9.2 OV_ONLINE_NOFWD_SYSCTL="$T/no-forward.conf"
RB="$T/state/ledbox-fw-rollback.sh"
STAGED="$T/sbin/ledbox-lan-guard.sh.new"
fire() { bash "$RB" timer >/dev/null 2>&1; rm -f "$STUB/timer"; }   # what the transient timer does after 240 s (then it is spent)
inst() { bash "$INSTALL" "$@" > "$T/out/last" 2>&1; }

# ── the network ─────────────────────────────────────────────────────────────────────────────────
ip link set lo up
unshare -n sleep 300 & NET=$!;  PIDS="$PIDS $NET"     # the internet behind the uplink (DERP, a peer)
unshare -n sleep 300 & PH=$!;   PIDS="$PIDS $PH"      # the phone on the board's Wi-Fi
unshare -n sleep 300 & LAP=$!;  PIDS="$PIDS $LAP"     # the laptop on the cable
unshare -n sleep 300 & TSP=$!;  PIDS="$PIDS $TSP"     # a tailnet peer (the owner's machine)
sleep 0.5
inns() { local p=$1; shift; nsenter -t "$p" -n --preserve-credentials "$@"; }
ip link add wlan1 type veth peer name n0;     ip link set n0 netns $NET
ip link add wlan0 type veth peer name p0;     ip link set p0 netns $PH
ip link add eth0 type veth peer name l0;      ip link set l0 netns $LAP
ip link add tailscale0 type veth peer name t0; ip link set t0 netns $TSP
ip addr add 10.9.9.1/24 dev wlan1;       ip link set wlan1 up; ip route add default via 10.9.9.2
ip addr add 172.24.1.1/24 dev wlan0;     ip link set wlan0 up
ip addr add 192.168.5.1/24 dev eth0;     ip link set eth0 up
ip addr add 100.64.0.5/10 dev tailscale0; ip link set tailscale0 up
inns $NET sh -c 'ip link set lo up; ip addr add 10.9.9.2/24 dev n0; ip link set n0 up; ip addr add 3.3.3.3/32 dev lo; ip route add default via 10.9.9.1'
inns $PH  sh -c 'ip link set lo up; ip addr add 172.24.1.50/24 dev p0; ip link set p0 up; ip route add default via 172.24.1.1'
inns $LAP sh -c 'ip link set lo up; ip addr add 192.168.5.50/24 dev l0; ip link set l0 up'
inns $TSP sh -c 'ip link set lo up; ip addr add 100.64.0.9/10 dev t0; ip link set t0 up'

# tailscaled's rules in iptables mode (1.7x): its chains hooked FIRST, before anything of ours.
for B in $I $I6; do $B -N ts-input; $B -N ts-forward; $B -I INPUT 1 -j ts-input; $B -I FORWARD 1 -j ts-forward; done
$I -A ts-input -s 100.64.0.5/32 -i lo -j ACCEPT
$I -A ts-input -s 100.115.92.0/23 ! -i tailscale0 -j RETURN
$I -A ts-input -s 100.64.0.0/10 ! -i tailscale0 -j DROP
$I -A ts-input -i tailscale0 -j ACCEPT
$I -A ts-input -p udp --dport 41641 -j ACCEPT
$I -A ts-forward -i tailscale0 -j MARK --set-xmark 0x40000/0xff0000
$I -A ts-forward -m mark --mark 0x40000/0xff0000 -j ACCEPT
$I -A ts-forward -s 100.64.0.0/10 -o tailscale0 -j DROP
$I -A ts-forward -o tailscale0 -j ACCEPT
$I6 -A ts-input -i tailscale0 -j ACCEPT
$I6 -A ts-input -p udp --dport 41641 -j ACCEPT
$I -t nat -N ts-postrouting; $I -t nat -I POSTROUTING 1 -j ts-postrouting
$I -t nat -A ts-postrouting -m mark --mark 0x40000/0xff0000 -j MASQUERADE

# ── long-lived sessions ─────────────────────────────────────────────────────────────────────────
cat > "$T/net.py" <<'EOF'
import socket, sys, threading, time, os
mode = sys.argv[1]
def put(path, text):
    tmp = path + ".t"; open(tmp, "w").write(text); os.replace(tmp, path)
if mode == "srv":                       # TCP echo on each port given
    def serve(port):
        s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", port)); s.listen(32)
        while True:
            c, _ = s.accept()
            def echo(c):
                try:
                    while True:
                        d = c.recv(64)
                        if not d: break
                        c.sendall(d)
                except OSError: pass
            threading.Thread(target=echo, args=(c,), daemon=True).start()
    for p in sys.argv[2:]: threading.Thread(target=serve, args=(int(p),), daemon=True).start()
    threading.Event().wait()
elif mode == "cli":                     # a session that must stay alive: one byte out, one back, 5x/s
    host, port, out = sys.argv[2], int(sys.argv[3]), sys.argv[4]
    n = 0
    try:
        s = socket.create_connection((host, port), timeout=4); s.settimeout(6)
        while True:
            s.sendall(b"x")
            if s.recv(1) != b"x": raise OSError("closed")
            n += 1; put(out, str(n)); time.sleep(0.2)
    except Exception as e:
        put(out, "DEAD %s" % e)
elif mode == "udpsrv":
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("0.0.0.0", int(sys.argv[2])))
    while True:
        d, a = s.recvfrom(64); open(sys.argv[3], "a").write("%s\n" % a[0])
elif mode == "udpsend":
    socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b"ping", (sys.argv[2], int(sys.argv[3])))
EOF
py() { python3 "$T/net.py" "$@"; }
py srv 22 8890 >/dev/null 2>&1 & PIDS="$PIDS $!"                       # the board's sshd and console
py udpsrv 41641 "$T/out/udp" >/dev/null 2>&1 & PIDS="$PIDS $!"          # tailscaled's direct port
inns $NET python3 "$T/net.py" srv 443 >/dev/null 2>&1 & PIDS="$PIDS $!" # the DERP server
sleep 0.5

tcp() { local ns=$1 h=$2 p=$3; inns "$ns" timeout 2 bash -c "exec 3<>/dev/tcp/$h/$p" >/dev/null 2>&1; }
newtcp_board() { timeout 2 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1; }
start() { # name, then where it runs ("" = on the board), host, port
  local name=$1 ns=$2 h=$3 p=$4
  rm -f "$T/out/$name"
  if [ -z "$ns" ]; then py cli "$h" "$p" "$T/out/$name" >/dev/null 2>&1 &
  else inns "$ns" python3 "$T/net.py" cli "$h" "$p" "$T/out/$name" >/dev/null 2>&1 & fi
  PIDS="$PIDS $!"; SESS="$SESS $!"
}
SESS=""
sessions() { # (re)start the four sessions
  [ -n "$SESS" ] && kill $SESS 2>/dev/null; SESS=""; sleep 0.3
  start derp "" 3.3.3.3 443                 # tailscaled's DERP connection (relay "fra"), out of wlan1
  start ts_ssh $TSP 100.64.0.5 22           # the operator's SSH over the tailnet
  start cable_ssh $LAP 192.168.5.1 22       # a laptop on the cable
  start ap_console $PH 172.24.1.1 8890      # the console tablet on the board's Wi-Fi
  sleep 1
}
alive() { # the session still moves data: its count went up over a second
  local f="$T/out/$1" a b
  a=$(cat "$f" 2>/dev/null); sleep 1; b=$(cat "$f" 2>/dev/null)
  case "$a$b" in *DEAD*|"") return 1 ;; esac
  [ "$b" -gt "$a" ] 2>/dev/null
}
all_alive() { alive derp && alive ts_ssh && alive cable_ssh && alive ap_console; }
which_dead() { local s o=""; for s in derp ts_ssh cable_ssh ap_console; do alive $s || o="$o $s($(cat "$T/out/$s" 2>/dev/null))"; done; echo "${o:-none}"; }
udp_in() { : > "$T/out/udp"; inns $NET python3 "$T/net.py" udpsend 10.9.9.1 41641; sleep 0.3; grep -q 10.9.9.2 "$T/out/udp"; }
rules() { { $I -S; $I -t nat -S; $I6 -S; } 2>/dev/null; }
chk() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fi; }

# ── 0. the board as it was on 18.11 before the install: the committed (13.11) firewall, enabled ──
cp "$OLD_FW" "$T/sbin/ledbox-lan-guard.sh"; echo enabled > "$STUB/enabled"
cp "$HERE/../provisioning/ledbox-lan-guard.service" "$T/units/"
bash "$T/sbin/ledbox-lan-guard.sh" >/dev/null 2>&1
# ...with the hand-applied OpenVolley opening of 17.11 still in place, kernel forwarding on for it
echo "server=/openvolley.app/10.9.9.2" > "$T/dns/zz-openvolley-online.conf"
$N -f - <<NFT
table inet ovonline { set ov4 { type ipv4_addr; flags timeout; timeout 3h; }
  chain ovfw { type filter hook forward priority -10; policy accept; iifname "wlan0" oifname "wlan1" tcp dport 443 ip daddr @ov4 meta mark set 0x77; }; }
NFT
$I -I LEDBOX-FWD 1 -i wlan1 -o wlan0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$I -I LEDBOX-FWD 1 -i wlan0 -o wlan1 -m mark --mark 0x77 -j ACCEPT
$I -t nat -A POSTROUTING -s 172.24.1.0/24 -o wlan1 -j MASQUERADE
echo 1 > /proc/sys/net/ipv4/ip_forward

sessions
chk "the test is real: the committed firewall is DROP by default with tailscale's chains first" \
  '[ "$($I -S INPUT | head -2 | paste -sd" ")" = "-P INPUT DROP -A INPUT -j ts-input" ] && $I -S INPUT | grep -qx -- "-A INPUT -j LEDBOX-IN"'
chk "the test is real: an unlisted port on the uplink is refused" '! tcp $NET 10.9.9.1 12345'
chk "before: DERP, SSH over the tailnet, the cable and the AP console all live" 'all_alive'

# ── 1. ledbox-ov-online off (18.11 21:44:16): forwarding back to 0, the 17.11 opening removed ────
"$OV_ONLINE_HELPER" off >/dev/null 2>&1
chk "ledbox-ov-online off: kernel forwarding 1 -> 0, the hand-applied opening gone" \
  '[ "$(cat /proc/sys/net/ipv4/ip_forward)" = 0 ] && ! $N list table inet ovonline >/dev/null 2>&1 && [ "$($I -S LEDBOX-FWD | grep -c "^-A")" = 1 ]'
chk "...and every session survives it: $(which_dead)" 'all_alive'
chk "...tailscale's chains untouched" '$I -S INPUT | grep -qx -- "-A INPUT -j ts-input" && $I -S FORWARD | grep -qx -- "-A FORWARD -j ts-forward" && $I -t nat -S POSTROUTING | grep -qx -- "-A POSTROUTING -j ts-postrouting"'

# ── 2. install-firewall.sh (no --commit) with the current ledbox-firewall.sh ─────────────────────
before=$(rules)
inst; rc=$?
chk "apply: exit 0 ($(tail -1 "$T/out/last"))" '[ $rc = 0 ]'
chk "apply: every session survived the rebuild: $(which_dead)" 'all_alive'
chk "apply: new connections: tailnet SSH, cable SSH, AP console, direct tailscale udp/41641, a new DERP" \
  'tcp $TSP 100.64.0.5 22 && tcp $LAP 192.168.5.1 22 && tcp $PH 172.24.1.1 8890 && udp_in && newtcp_board 3.3.3.3 443'
chk "apply: still default-deny (an unlisted uplink port refused, the phone routes nowhere)" '! tcp $NET 10.9.9.1 12345 && ! tcp $PH 3.3.3.3 443'
chk "apply: tailscale's hooks and chains kept (v4, v6, nat)" \
  '[ "$($I -S INPUT | sed -n 2p)" = "-A INPUT -j ts-input" ] && $I6 -S INPUT | grep -qx -- "-A INPUT -j ts-input" && [ "$($I -S ts-input | grep -c ^-A)" = 5 ] && $I -t nat -S POSTROUTING | grep -qx -- "-A POSTROUTING -j ts-postrouting"'
chk "apply: STAGED — the committed script and the enabled boot unit are untouched" \
  'cmp -s "$OLD_FW" "$T/sbin/ledbox-lan-guard.sh" && cmp -s "$FW" "$STAGED" && [ "$(cat $STUB/enabled)" = enabled ] && ! grep -q "systemctl disable" $STUB/calls'
chk "apply: the rollback is armed for 240 s and runs from its own file, no \$ for systemd to expand" \
  'grep -q -- "--on-active=240" $STUB/run.args && grep -q -- "/bin/bash $RB timer" $STUB/run.args && [ -x "$RB" ] && ! grep -q "\\$" $STUB/run.args'
chk "apply: every step is in the install log" 'grep -q "apply: snapshot saved" $T/state/ledbox-fw-install.log && grep -q "apply: applied and checked" $T/state/ledbox-fw-install.log'

# ── 3. the timer fires (never committed) ─────────────────────────────────────────────────────────
fire
chk "rollback: the rules are exactly the ones from before the apply" '[ "$(rules)" = "$before" ]'
chk "rollback: every session survived the restore: $(which_dead)" 'all_alive'
chk "rollback: new tailnet SSH and a new DERP connection work" 'tcp $TSP 100.64.0.5 22 && newtcp_board 3.3.3.3 443'
chk "rollback: nothing left behind — no staged script, the committed one and the unit as before" \
  '[ ! -e "$STAGED" ] && cmp -s "$OLD_FW" "$T/sbin/ledbox-lan-guard.sh" && [ "$(cat $STUB/enabled)" = enabled ]'
inst --commit; rc=$?
chk "--commit after the rollback fired: refused, says why (exit $rc)" '[ $rc = 1 ] && grep -q "nothing to commit" $T/out/last'

# ── 4. a rebuild killed half way (the SSH session dropped): what it does, and the rollback fixes it ─
inst; rc=$?
for B in $I $I6; do $B -F LEDBOX-IN; done          # LEDBOX-IN flushed, INPUT policy still DROP
chk "half-built: a new DERP connection out of wlan1 fails (its replies meet the DROP policy)" '! newtcp_board 3.3.3.3 443'
chk "half-built: ...while tailscale0 itself is still let in by ts-input" 'tcp $TSP 100.64.0.5 22'
fire
chk "half-built + the timer: DERP connects again, the rules are the ones from before" 'newtcp_board 3.3.3.3 443 && [ "$(rules)" = "$before" ]'
# The sessions that were open across the break may or may not have outlived it (TCP back-off);
# tailscaled would simply reconnect. Fresh ones for what follows.
sessions

# ── 5. SIGHUP to the whole process group mid-apply (the terminal went away): it finishes anyway ──
printf '#!/bin/bash\nsleep 1\nexec bash %q "$@"\n' "$FW" > "$T/slowfw.sh"
SRC="$T/slowfw.sh" setsid bash "$INSTALL" > "$T/out/hup" 2>&1 & ip=$!
sleep 0.6; kill -HUP -- -"$ip" 2>/dev/null; wait "$ip"; rc=$?
chk "SIGHUP mid-apply: the apply still completes (exit $rc)" '[ $rc = 0 ] && grep -q "apply: applied and checked" $T/state/ledbox-fw-install.log && [ "$($I -S LEDBOX-IN | grep -c ^-A)" -gt 20 ]'
chk "SIGHUP mid-apply: sessions alive: $(which_dead)" 'all_alive'
fire
chk "...and its rollback still restores the rules from before" '[ "$(rules)" = "$before" ]'

# ── 6. apply + --commit: installed, enabled, the timer a no-op ───────────────────────────────────
inst && inst --commit; rc=$?
after=$(rules)
chk "--commit: exit 0, the new script installed, the unit enabled, nothing staged" \
  '[ $rc = 0 ] && cmp -s "$FW" "$T/sbin/ledbox-lan-guard.sh" && [ ! -e "$STAGED" ] && [ "$(cat $STUB/enabled)" = enabled ] && [ ! -e $STUB/timer ]'
fire
chk "--commit: a timer firing late changes nothing" '[ "$(rules)" = "$after" ]'
chk "--commit: sessions alive: $(which_dead)" 'all_alive'

# ── 7. a first install (no committed firewall, unit disabled) stays disabled until --commit ──────
rm -f "$T/sbin/ledbox-lan-guard.sh"; echo disabled > "$STUB/enabled"; : > "$STUB/calls"
inst; rc=$?
chk "first install: applied, nothing committed, unit still disabled" '[ $rc = 0 ] && [ ! -e "$T/sbin/ledbox-lan-guard.sh" ] && [ -e "$STAGED" ] && [ "$(cat $STUB/enabled)" = disabled ]'
inst --rollback-now; rc=$?
chk "--rollback-now: exit 0, staged script gone, timer disarmed" '[ $rc = 0 ] && [ ! -e "$STAGED" ] && [ ! -e $STUB/timer ]'

# ── 8. a ruleset that would cut the board is rolled back by the apply itself, at once ────────────
printf '#!/bin/bash\n/usr/sbin/iptables -w 5 -N LEDBOX-IN 2>/dev/null; /usr/sbin/iptables -w 5 -F LEDBOX-IN\n/usr/sbin/ip6tables -w 5 -F LEDBOX-IN\nexit 0\n' > "$T/badfw.sh"
pre=$(rules)
SRC="$T/badfw.sh" bash "$INSTALL" > "$T/out/bad" 2>&1; rc=$?
chk "a ruleset without the ESTABLISHED / tailscale0 accepts: refused and rolled back at once (exit $rc)" \
  '[ $rc = 1 ] && grep -q "missing" $T/out/bad && [ "$(rules)" = "$pre" ] && [ ! -e "$STAGED" ] && newtcp_board 3.3.3.3 443'
chk "...--check reads it all back without changing anything" 'r0=$(rules); inst --check && grep -q "boot unit ledbox-lan-guard.service" $T/out/last && [ "$(rules)" = "$r0" ]'
echo "DONE"
