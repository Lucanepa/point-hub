# Board provisioning

One-time setup applied to the LedBox board itself (it is a Raspberry Pi). Separate from
`deploy-board.sh`, which ships the bridge and runs every release.

Run from a host that can reach the board over SSH.

## Why the board needs its own uplink

The board has **no RTC**. `fake-hwclock` only replays the last known time at boot, so if the board
cannot reach NTP its clock silently drifts — and because **the bridge runs on the board**, every
match-history timestamp is stamped with the board's wrong clock. This has bitten us: the clock was
once ~36 h behind and the scoreboard worked perfectly the whole time.

Originally the board's only route out was a cabled Pi doing NAT for it, which made that Pi a single
point of failure for timekeeping. A USB wifi adapter gives it a second, independent path.

## 1. Wifi client uplink — `setup-wlan1-client.sh`

```bash
./setup-wlan1-client.sh --check              # is the adapter enumerated?
./setup-wlan1-client.sh --scan               # what's visible
./setup-wlan1-client.sh --connect "SSID" sae a
./setup-wlan1-client.sh --verify
```

Args are `<SSID> [sae|wpa-psk] [a|bg|auto]` — `sae` = WPA3-Personal, `a` = 5 GHz.

Stage the passphrase in a file first so it never appears in a command line, in `ps`, or in shell
history. Pull it straight from the vault:

```bash
ssh <board> 'sudo install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" /run/ledbox'
rbw get "<vault item>" | tr -d '\n' | ssh <board> 'umask 077; cat > /run/ledbox/wl1'
```

`/run`, not `/tmp`: tmpfs, cleared at reboot, and not a directory every other process on the board
can write into. The old `/tmp/wl1.txt` is still picked up if that is where you staged it, and
`PASSFILE=` overrides both. If a copy exists at *both* paths — the state this very migration leaves
behind when the old file was never cleaned up — `/run` is the one that gets read, but `--connect`
shreds **both**, and the read-only modes name both. The `/tmp` copy used to survive unmentioned.

The script writes a `0600` NetworkManager keyfile directly rather than using
`nmcli ... wifi-sec.psk`, which would expose the secret in `ps`.

`--connect` **shreds the staged file on every exit path**, including the early "wlan1 absent" and
"passphrase too short" ones — it used to shred only on success, which left the house PSK in
cleartext exactly when you had made a typo and were about to re-run. It also refuses to read a
staging file that is not yours (or root's) at mode `0600`, and rejects a passphrase containing a
control character: GKeyFile un-escapes `\\`, `\s` and `\n` on the way back out, so those are
written escaped and a stray CR would otherwise become a different passphrase — discovered as
"wlan1 won't associate" long after the staged copy is gone.

A **control** character, not "anything non-printable". The check is `[[:cntrl:]]`; the negated
`[![:print:]]` form it replaced also rejected every non-ASCII byte under the `C` locale, which is
what a bare `ssh <board> 'cmd'` runs in when the board has no generated locale — so an SSID with an
umlaut was accepted from an interactive login and refused over plain `ssh`, blaming a control
character that was not there. Non-ASCII round-trips into the keyfile byte-identically.

`--check`, `--scan` and `--verify` only *warn* if a staged passphrase is still lying around; they
do not delete it, because staging and then scanning to pick the right SSID is a normal sequence.

### Choices that matter

- **`band=a` (5 GHz), not auto.** The board's own AP runs on 2.4 GHz. Left on auto, the client
  radio may land on 2.4 GHz too and desense the AP the console tablet depends on. Separate bands,
  and separate radios — the AP stays on the built-in chip, the client goes on the USB adapter.
- **`route-metric=50`** against the cabled profile's `100`. Wifi wins when present, and the cabled
  NAT path stays as an automatic fallback. The aim is *two* paths, not a different single one — so
  keep the NAT unit on the upstream Pi.
- **`key-mgmt`** must match the AP. Check `--scan` output: a WPA3 network needs `sae`, and
  `wpa-psk` will simply fail to associate.
- `wlan0` is NM-unmanaged (see `/etc/NetworkManager/conf.d/`), otherwise NM flushes the AP's
  gateway IP a few seconds after boot. That rule is matched **per interface name**, so `wlan1` is
  managed automatically and needs no change.

### The hall's open Wi-Fi — `--hall`

```bash
./setup-wlan1-client.sh --hall                     # Free_WLAN_KTZH, the KWI hall
./setup-wlan1-client.sh --hall "Some_Other_Open"   # another open network
```

Creates (or, on every later run, puts back) an NM connection `hall-uplink` for an **open** SSID on
`wlan1`: autoconnect priority `5`, route metric `60`, and
`ipv4.dns-options "single-request-reopen,timeout:1,attempts:3"`. No passphrase is involved, so
nothing is staged. Idempotent — re-running it is also how to repair a board edited by hand.

Free_WLAN_KTZH is a Swisscom Public WLAN: joining is free, but until the board has done a Free-SMS
login every HTTP request is redirected to `login.pwlan.ch`. That login is done **from the console**
(Settings ▸ Hall internet: the scorer's mobile number, then the SMS code), because the board walks
the portal itself — a login done in the tablet's own browser would log in the tablet, which is on
the board's AP and not on the hall Wi-Fi at all. With automatic login ticked, which the board always
does, the portal keeps the board's MAC logged in for about 24 h. The number is never stored.

- **Priority 5 / metric 60**, below the house network (`ledbox-uplink`: 10 / 50) and above the Pi's
  cabled `eth0` (100). A board that can see both joins the one with no login page.
- **The DNS options are the part that matters.** glibc sends the A and AAAA queries for a name in
  parallel from one socket, and the portal network's resolver drops one of the pair. The resolver
  then waits out its full 5 s default before retrying, so *every* name lookup stalled 5 s — longer
  than livePush's 2 s request timeout. Live scoring failed on every single point while `ping` by
  address, and even the console, looked perfectly healthy. `single-request-reopen` sends the second
  query from a fresh socket, which is what gets it answered; `timeout:1,attempts:3` caps whatever
  stall is left at a second instead of five. Check it took effect with
  `grep options /etc/resolv.conf` while `hall-uplink` is up (`--hall` prints it when it re-applies
  to an active connection) — the options only apply if NetworkManager is writing `resolv.conf`.

### The school network SCHULEN_KTZH — `--login`

```bash
ssh -t pi@172.24.1.1 bash ledbox-bridge/provisioning/setup-wlan1-client.sh --login   # asks, then ONE attempt
ssh -t pi@172.24.1.1 bash ledbox-bridge/provisioning/setup-wlan1-client.sh --forget-login
```

`172.24.1.1` is the board on its own AP (`ledbox_C0270`). The path is **relative, not `~/…`**: an
unquoted `~` is expanded by the *laptop's* shell into the laptop user's home, and the board then
says "No such file or directory". `bash` in front means the file's exec bit does not matter.

The canton's school Wi-Fi at KWI (LEUnet Schule). Settings from the MBA's LEUnet handbook (V2.2,
11 Jul 2024, `help.mba.zh.ch`, "Anmeldung SCHULEN_KTZH für Android"): **WPA2-Enterprise,
EAP-TTLS / PAP**, server certificate from **SwissSign Gold CA - G2** for the domain **`ktzh.ch`**,
username `vorname.nachname.schule` (…`.kwi`), the Sek II intranet password.

- **One attempt, never a guessing loop.** The handbook: wrong credentials, too many attempts and a
  password change each **lock the account for up to 8 hours**. So the method is fixed, and the
  username is checked for the `first.last.school` shape *before* anything is sent — a swapped pair
  is refused outright (it would send the password as the identity, which goes out in clear), an
  odd-looking username needs `ODD_USERNAME=1`. Capitals are fine; a non-ASCII letter is refused
  with a hint (ü → ue).
- **"One attempt" takes two NM settings.** With a saved password, NM does not stop at the first EAP
  failure: it waits out `802-1x.auth-timeout` (25 s default) while wpa_supplicant re-enables the
  network 10 s after the reject and sends the password again — two strikes from one
  `nmcli connection up`. And a profile that has connected before goes round that up to 1 + 3
  times (`connection.auth-retries`). So the profile carries **`auth-timeout=12`** (a TTLS/PAP
  exchange takes 2–5 s; the re-send cannot start before ~12 s) and **`auth-retries=1`**, and every
  `--login` deletes any earlier `hall-login` first, so a refusal ends as "no secrets" instead of
  replaying a saved password. A refused login deletes the profile again (Ctrl-C mid-attempt too).
- **The failure report says whether a strike was spent.** It reads wpa_supplicant's journal as well
  as NM's: a certificate refusal (`TLS-CERT-ERROR`) means the password was never sent and a retry
  is safe; `EAP-FAILURE` lines are refusals by the server, each one counting. Read it before
  trying again.
- **The certificate check is mandatory.** PAP sends the password itself inside the TLS tunnel, so
  without the check any AP named SCHULEN_KTZH would read it. The CA is `swisssign-gold-ca-g2.pem`
  shipped next to the script (deploy copies both), else the system's copy; its SHA-256 fingerprint
  is checked either way, and it is then installed at `/etc/NetworkManager/certs/` for the profile —
  Mozilla is retiring roots of Gold G2's age, and an `apt upgrade` dropping the system symlink must
  not silently break the uplink later. The board's clock has to be roughly right for the
  certificate dates — the script stops on a clock before 2026.
- **If the account's password changes, run `--forget-login` straight away**, then `--login` with
  the new one: until then every boot presents the old password — about 2 strikes per boot even
  with `auth-retries=1` (0 would mean unlimited), after which NM blocks it until the next reboot.
- Saved as its own NM connection **`hall-login`**: priority 8 (above Free_WLAN_KTZH's 5, below the
  house's 10), metric 55, the same DNS options as `hall-uplink`, `band=a` when seen on 5 GHz.
- **Run it over the AP or the cable, not Tailscale** — the attempt drops wlan1, which would cut a
  session riding on it; the script refuses (`FORCE=1` overrides that check and nothing else).
- Credentials are asked for (password not echoed — hence `ssh -t`) or read from `LOGINFILE`
  (default `/run/ledbox/login`: username line 1, password line 2, `0600`), shredded on every exit.

Another 802.1X network: `--login "SSID"` with `METHOD=eap:phase2` (default `peap:mschapv2`) and,
when known, `DOMAIN=` (system CAs) or `CA=`. Still one attempt. WPA-Personal: the password is the
passphrase. Open: that is a web login page — capture it as a HAR, like Free_WLAN_KTZH.

### A volunteer's phone hotspot — `--hotspot`

```bash
ssh -t <board> bash ledbox-bridge/provisioning/setup-wlan1-client.sh --hotspot   # asks the passphrase
ssh <board> bash ledbox-bridge/provisioning/setup-wlan1-client.sh --forget-hotspot
```

Pre-provisions NM connection `phone-hotspot` for the SSID **`KSCW-Board`**: WPA2, **no band pin**
(Android hotspots are often 2.4 GHz only; an iPhone's is 5 GHz unless *Maximize Compatibility* is on),
priority **6** — above Free_WLAN_KTZH (5), which sits behind an SMS login, below the school login (8)
and the house (10) — metric 58. On the day, a volunteer sets their hotspot to that name and the
passphrase on the hall card, and the board has internet without anyone touching it. Android lets you
set the SSID directly; an iPhone's hotspot is named after the phone, so the iPhone itself has to be
renamed. The passphrase is asked for (not echoed) or read from `/run/ledbox/hotspot` (0600, shredded),
and goes only into a 0600 keyfile. A hotspot passphrase on a hall card is semi-public, which is fine
for a CLIENT whose traffic is all HTTPS or WireGuard. NetworkManager does not leave a working
connection for a higher-priority one that appears later: a board already on Free_WLAN_KTZH switches at
its next reconnect (`sudo nmcli connection up phone-hotspot`). The phone giving the hotspot must not
be the console tablet.

### Adapter notes

Tested with a Netgear A6210 (MT7612U, USB `0846:9053`). No driver install: `mt76x2u` is in-kernel
and `mediatek/mt7662u.bin` ships with Raspberry Pi OS. It enumerates directly into wifi mode — the
driver CD it advertises is a Windows installer and is irrelevant here. If a different adapter
appears as USB storage instead, that is CD-ROM mode and needs `usb-modeswitch`; `--check` says so
explicitly.

## 2. Daemon hardening — `harden-board.sh`

Run once, idempotent, backs up every file it edits. Must be run as root, and now says so instead
of reporting a hardened board it never touched. It exits non-zero if any step failed, and each
step prints its own result rather than an unconditional "done".

```bash
sudo ./harden-board.sh
```

- **SSH key-only.** `:22` is reachable from the house LAN, the `pi` account *has* a password, and
  there is no fail2ban. Password auth was the single most valuable target on the board. The script
  refuses to proceed unless `authorized_keys` holds at least one real key line.

  That guard **used to fail open in exactly the case it exists for**: on an *empty*
  `authorized_keys`, `grep -c .` prints `0` *and* exits 1, so an `|| echo 0` fallback fired as
  well, the count became `0\n0`, `[ -lt ]` bailed with "integer expected", and the else branch ran
  — "safe to proceed", passwords disabled, zero keys, board on a wall. A *missing* file always
  worked. It now discards the exit status, insists the count is a plain number, drops comment and
  blank lines first, and then counts lines carrying an `ssh-`/`ecdsa-`/`sk-` key type — so a file
  of pure comments is not mistaken for a way in, while `from="…",restrict ssh-ed25519 …` and
  `command="…" ssh-rsa …` still count. Anchoring the key type to the start of the line instead
  refused a board whose only key carried options.
- **apache2 disabled, not deleted.** It serves Tech4Sport's setup UI from `/home/pi/ledbox/www`.
  Nothing depends on it: no reverse systemd dependency, no reference to `localhost:80` under
  `/home/pi/ledbox`, the bridge reaches the panel on loopback, and the AP already NAT-redirects
  `:80` to our own console (`ledbox-http-redirect`). Its front page is a hard PHP fatal anyway.
  Files are untouched, so `systemctl enable --now apache2` undoes it.
- **dnsmasq `bind-dynamic`.** Its config says `interface=wlan0`, but without a bind directive it
  still listens on `*:53` and will answer the house LAN as an open resolver. `bind-dynamic` rather
  than `bind-interfaces` because wlan0's IP is assigned late — `bind-interfaces` would race it.
- **avahi restricted to the AP**, so the board stops advertising itself across the house.

## 3. Firewall — `ledbox-firewall.sh` + `install-firewall.sh` + `ledbox-lan-guard.service`

Default-deny INPUT with per-interface allows, ordered by trust: `wlan1` (house LAN) least,
then `eth0` (link to the Pi), then `wlan0` (the board's own AP, where the console tablet lives),
then `lo` (the bridge reaches the panel at `LEDBOX_HOST=127.0.0.1:8889` through here).

This is not a theoretical concern. Within five minutes of one board joining a home LAN it was
probed with ONVIF, RTSP and Log4Shell JNDI payloads — from the router itself, so near-certainly a
consumer security suite auto-scanning a new device, but it makes the point.

```bash
sudo ./install-firewall.sh              # applies, with a 240s auto-rollback armed
# ... verify from another machine ...
sudo ./install-firewall.sh --commit     # disarms the rollback AND enables the boot unit
sudo ./install-firewall.sh --rollback-now   # or undo immediately
```

Run it **from this checkout** — it installs `ledbox-firewall.sh` from its own directory. Override
with `SRC=`. (It used to install from a hardcoded `/tmp/ledbox-firewall.sh` that nothing in this
repo ever wrote, without checking the copy succeeded, then print "installed" and re-run whatever
old ruleset was already on the board. The documented invocation therefore did nothing, quietly.)

**Applying a default-deny policy over SSH is the classic way to brick a remote device**, so the
installer snapshots the current rules and arms a rollback that restores them unless you commit.
If the new rules cut your own access, the board recovers by itself. The rollback has two legs:

- **session leg** — a transient `systemd-run --on-active` timer, which outlives the SSH session.
  It replaced a `setsid nohup … sleep 240`, which a **reboot destroyed while the ruleset lived
  on** — so rebooting inside the grace window was an unrecoverable lockout, the exact outcome the
  rollback exists to prevent.
- **reboot leg** — the unit is installed *disabled*, and `--commit` is what enables it. An
  uncommitted ruleset simply does not come back after a reboot, and the kernel's INPUT policy
  resets to ACCEPT on boot, so the board reboots into a reachable state.

`--commit` fails loudly if it cannot enable the unit, rather than printing "committed" over a
board that would revert at the next boot.

The restore is a **function**, not a re-exec of `$0`. Run as `bash install-firewall.sh` — the
natural fallback when the checkout arrived without the exec bit — `$0` is a bare filename with no
path, so the apply path's emergency rollback died with `command not found` immediately after
printing "rolling back now". The operator read that as "the board was restored" and nothing had
been. The boot unit is also disabled only *after* the rollback is armed: the arming can fail, and
that path touches netfilter not at all, but it used to leave an already-committed board's unit
disabled — so the next reboot came up unfirewalled with nothing anywhere saying so.

### Choices that matter

- **`wlan0` is deliberately not rate-limited.** A scorer throttled mid-match is a worse outcome
  than anything the limit would prevent. Brute-force protection for the PIN belongs in the app,
  where it can be precise — see `src/pinGate.js`.
- **`udp/68` on wlan1 is not optional.** Without it the DHCP lease never renews and the uplink
  dies hours later, which presents as a wifi fault rather than a firewall one.
- **ICMPv6 is accepted unconditionally.** Neighbour discovery is not optional; dropping it breaks
  IPv6 in ways that surface much later as random failures.
- **INPUT is only ever appended to, never flushed.** Tailscale owns `-j ts-input` there and re-adds
  it on its own schedule, so an `iptables-restore` of the whole filter table would silently delete
  tailscale's rules and cut the management path. All our rules live in a private `LEDBOX-IN` chain.
- `:8890` and `:22` stay reachable from the house LAN on purpose, so the console works from a
  device on house wifi without joining the board's AP. Everything else — `:80`, `:8889`, `:12345`,
  `:53` — is refused there by the default policy rather than by explicit DROPs.
- **`-P INPUT DROP` goes on last, and only if every allow landed.** Every `iptables` call carries
  `-w 5` and records its exit status; if any fails, the policy is forced back to `ACCEPT`. The
  chain is flushed before it is rebuilt, so a DROP policy over a half-built chain is a board with
  no console, no SSH and no tailscale — reachable only by ladder. An unfirewalled board is
  recoverable during a match; a locked-out one is not.
- **…but falling open takes two failures, not one.** The build is retried **once**, per family,
  after a 3 s pause, and only then is the open policy accepted as final. `-w 5` already handles
  most of the transient xtables-lock case; the retry covers the rest. This matters because nothing
  *else* retries: the unit is `Type=oneshot`, systemd forbids `Restart=` on oneshot, and the only
  place the failure shows is `systemctl status`, which nobody reads mid-match. The exit status
  reflects the **final** state — a family rescued by its retry does not leave the unit `failed`,
  because a red unit over a correctly firewalled board sends someone poking at netfilter for
  nothing. The failed-call count is still printed either way.
- **A genuine failure is shouted, not filed.** `ExecStopPost` logs at `daemon.emerg` when the unit
  did not succeed, so "board is UNFIREWALLED" lands in the journal and on every logged-in terminal
  rather than waiting to be discovered.
- **The `hashlimit` fallback carries the ACCEPT, and is probed per family.** `iptables -m hashlimit
  -h` only probes userspace, so a missing `xt_hashlimit` gave silent insert failures under a
  cheerful "per-source-IP" — the probe now inserts a real rule into a throwaway chain. It runs
  **once for each of v4 and v6**: `ip6t_hashlimit` is a separate module, and reusing one v4 answer
  for the v6 build used to cost only the v6 rate limit, but now that every failed rule counts it
  would force `-P INPUT ACCEPT` for the whole v6 family. And the `-m limit` fallback was inverted:
  `-j RETURN` matches what is *under* the limit, so normal traffic returned into the DROP policy
  while floods fell through to the ACCEPT below. Both branches now emit the port's own ACCEPT.

Installed as a **systemd unit, not a hand-added rule** — `ledbox-lan-guard.service`, which lives
in this directory and is installed by `install-firewall.sh`. A hand-added `iptables` rule is
precisely what silently disappeared on a reboot once and took the board's clock with it.

## 4. Frame buffers in RAM — `ledbox-buffer-tmpfs.sh` + `ledbox-buffer-tmpfs.service`

The vendor's renderer writes every frame to the SD card, twice — `buffer.save('www/buffer.png')`
and `buffer_compressed.save(...)` in `LEDMatrix2.py:44-46` — and `flushBuffer2` reads the first
back at ~62 fps. Measured at idle on this board that is **~4.6 MB/min from `ledbox.py` alone,
about 6.4 GB/day** if it is left powered, which it is.

The card is an `SD16G` with a Phison controller **dated 10/2019**. Small rewrite-in-place files
are the worst possible workload for SD flash: a 7 KB overwrite can cost a whole erase block, so
the wear is much larger than the byte count. Neither file is worth persisting — both are
regenerated on the next frame.

```bash
scp provisioning/ledbox-buffer-tmpfs.sh provisioning/ledbox-buffer-tmpfs.service <board>:/tmp/
ssh <board> 'sudo install -m 0755 /tmp/ledbox-buffer-tmpfs.sh /usr/local/sbin/ledbox-buffer-tmpfs'
ssh <board> 'sudo install -m 0644 /tmp/ledbox-buffer-tmpfs.service /etc/systemd/system/'
ssh <board> 'sudo systemctl daemon-reload && sudo systemctl enable --now ledbox-buffer-tmpfs'
ssh <board> 'ledbox-buffer-tmpfs status'
```

A **bind mount** of a file in `/run`, deliberately not a symlink: it changes nothing on the card,
so `stop` restores the original state exactly, and a vendor firmware update cannot leave a
dangling link behind.

Three things were checked before trusting it, each of which would have broken something:

- **Nothing unlinks these files.** A bind-mounted file cannot be removed (`EBUSY`), so an
  `os.remove()` on either path would have broken the vendor app rather than the mount. Their only
  `os.remove()` calls are for layouts, uploads and their own logs.
- **`bin/startled`, `bin/startledbox` and `bin/stopledbox` all `cp` onto `buffer.png`.** `cp`
  opens the destination `O_WRONLY|O_TRUNC` — it does not unlink — so the mount survives a restart.
- **`bin/watchdog` treats `buffer.png`'s mtime as the "is the app still painting?" signal** and
  restarts the app when it goes stale. Writes to a tmpfs file update mtime exactly as on disk.

Ordered `Before=rc-local.service` so the mounts exist before the first frame, but nothing
`Requires` it: if the unit fails, the vendor app writes to the card exactly as before and the
scoreboard still comes up.

## 5. The on-site kit (2026-10-23) — shared rules

The scripts below were written for the visit in `docs/onsite-2026-10-23.md`, which is the order to
run them in. They share `lib-provision.sh` (sourced, never run) and the same contract:

- **`--check` is the default and is read-only.** `--apply` changes things, `--rollback` undoes the
  newest `--apply` that changed anything. Run as root on the board, from the bridge install that
  `deploy-board.sh` keeps current: `sudo bash ledbox-bridge/provisioning/<script> [--check|--apply|--rollback]`.
  `deploy-board.sh` **ships** them and never **runs** them.
- **Backups go to `/var/backups/ledbox/<script>-<stamp>/`, not next to the file.** dnsmasq loads every
  file in `/etc/dnsmasq.d` and NetworkManager every file in `system-connections` whose suffix it does
  not know — a `foo.conf.bak` there is a second, live config. A file that did not exist is recorded as
  absent, so a rollback deletes it again. Each rollback marks its run `.rolled-back`, so a second one
  steps back one run further: apply one step per run and each step can be undone on its own.
- **A re-run that finds everything in place writes nothing** — no backup run, nothing for a rollback
  to "undo".
- **`cmdline.txt` is edited token-wise**, refused if it is not exactly one line, checked to keep the
  same `root=` and stay one line before it is written, and copied to `cmdline.txt.bak-<stamp>` on the
  FAT partition too — the one place a laptop can reach when the board does not boot.
- Scripts that restart hostapd or dnsmasq refuse to run from a session that comes in over the AP
  they are about to restart (`FORCE=1` to insist).

## 6. Supervision — `setup-supervision.sh`

Steps `watchdog restart probe hwdog crashlog` (`--apply <step>`; none = all five in one run):

- **watchdog** — re-enables `ledbox-watchdog` (disabled since 2026-07-31, `firmware/RECOVERY.md`), with
  `Restart=always` on its own unit, after installing the repo's `firmware/ledbox-watchdog.sh` over an
  older copy (the old one turned the first NTP step into a pkill of a healthy app). If an old copy had
  started the panel driver inside its own cgroup, the restart takes the panel down — the script starts
  it again at once, the same way the watchdog does.
- **restart** — `Restart=on-failure` for hostapd and dnsmasq (Debian ships neither with one; a crashed
  hostapd is a board with no AP until a power cycle). Bounded: 10 tries in 5 minutes.
- **probe** — `ledbox-bridge-probe`: a bridge that is active but no longer answers `/api/status` (a
  wedged event loop never exits, so `Restart=always` never fires) is restarted after 3 misses 30 s
  apart. A loop service, not a timer, so a healthy board logs nothing.
- **hwdog** — the bcm2835 hardware watchdog through systemd (`RuntimeWatchdogSec=14s`, hardware max
  ~15 s; `RebootWatchdogSec=2min`) and `kernel.panic=10`. Catches the kernel/I-O hang nothing in
  userspace can see. Refuses if another process holds `/dev/watchdog`. The rollback only re-execs
  systemd to disarm early when the kernel reports `nowayout=0`; otherwise it waits for the next reboot.
- **crashlog** — a persistent journal capped at 64 MB and synced every minute (`journalctl -b -1`
  shows the run up to a reset), plus `dtoverlay=ramoops` so a panic's last kernel lines land in
  `/var/lib/systemd/pstore` (needs a reboot).

## 7. Quiet core — `setup-quiet-core.sh`

Appends hzeller's `isolcpus=domain,managed_irq,3 nohz_full=3 rcu_nocbs=3 irqaffinity=0,1,2` to
`cmdline.txt`, so interrupts and the timer tick stay off the core the refresh thread already runs on,
and blacklists `snd_bcm2835` (with hardware pulsing the library exits if it loads, so an update that
re-enables it would darken the panel). Refuses the blacklist if the module is loaded right now. Needs a
reboot with eyes on the panel; the header says how to recover from a laptop if the board will not boot.

## 8. Wi-Fi country — `setup-wifi-country.sh`

Steps `hostapd regdom`. `hostapd` sets `country_code=CH`, `ieee80211d=1`, `wmm_enabled=1` in the
config hostapd is actually started with (found from `/etc/default/hostapd`, the unit, else
`/etc/hostapd/hostapd.conf`), changes nothing else, refuses a 5 GHz AP, and puts the old file back at
once if hostapd does not come up again. `regdom` adds `cfg80211.ieee80211_regdom=CH` to `cmdline.txt`
(what raspi-config's WLAN country does on bookworm) so wlan1 starts in CH too. `--check` greps the
vendor tree for code that writes the hostapd config, and never prints the passphrase.

## 9. Boot order, Node, cable DHCP

- **`bridge-boot-order.sh`** — `--check` measures (`systemd-analyze critical-chain`, `blame`, who
  pulls `network-online.target`); `--apply` changes the installed unit to `After=network.target` with no
  `Wants=network-online.target`, like `systemd/ledbox-bridge.service` now. Next boot.
- **`update-node.sh`** — installs a pinned Node 22 armv7l tarball (sha256 in the script) to
  `/opt/nodejs-<ver>`, flips `/opt/nodejs` atomically, restarts the bridge and flips back by itself if
  it is not healthy within 20 s. `--rollback` flips to the previous version, which stays on disk.
- **`setup-cable-dhcp.sh`** — dnsmasq also serves DHCP on eth0 (192.168.5.50–99, 15 min leases, no
  router and no DNS option), never on wlan1, so the tablet works over a USB-C Ethernet adapter. It needs
  `udp/67` on eth0 in `ledbox-firewall.sh` (install with `install-firewall.sh`). **The board's network
  port is for the tablet or a laptop only — never a hall or school switch**: the board would hand out
  addresses there, and the appliance trusts a client on the cable without the scorer PIN.
- **`setup-wlan1-client.sh --hotspot`** — a pre-provisioned phone-hotspot uplink (`KSCW-Board`, see §1).

## Gotchas on the board

- **`iw` and `modinfo` are not installed.** Both return "command not found", which looks exactly
  like a negative result once piped into `grep` — this produced a confident, wrong "the driver has
  no alias for this device". Use `/lib/modules/$(uname -r)/modules.alias`, and note USB aliases
  there are four hex digits (`v0846p9053`), not zero-padded to eight.
- Apache may still log in a stale timezone if it was started before the system TZ was corrected.
  Restart it if log timestamps matter.
- Layout files live on the board's own disk and deploy separately — see
  `firmware/idle-crest-qr/README.md`. Multi-dot filenames in the layout directory hang the board
  at "starting…".
