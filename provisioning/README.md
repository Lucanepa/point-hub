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
