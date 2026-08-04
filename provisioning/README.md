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

Stage the passphrase at `/tmp/wl1.txt` first so it never appears in a command line, in `ps`, or in
shell history. Pull it straight from the vault:

```bash
rbw get "<vault item>" | tr -d '\n' | ssh <board> 'umask 077; cat > /tmp/wl1.txt'
```

The script writes a `0600` NetworkManager keyfile directly rather than using
`nmcli ... wifi-sec.psk`, which would expose the secret in `ps`, then shreds the staged file.

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

Run once, idempotent, backs up every file it edits.

```bash
sudo ./harden-board.sh
```

- **SSH key-only.** `:22` is reachable from the house LAN, the `pi` account *has* a password, and
  there is no fail2ban. Password auth was the single most valuable target on the board. The script
  refuses to proceed if `authorized_keys` is empty, so it cannot lock you out.
- **apache2 disabled, not deleted.** It serves Tech4Sport's setup UI from `/home/pi/ledbox/www`.
  Nothing depends on it: no reverse systemd dependency, no reference to `localhost:80` under
  `/home/pi/ledbox`, the bridge reaches the panel on loopback, and the AP already NAT-redirects
  `:80` to our own console (`ledbox-http-redirect`). Its front page is a hard PHP fatal anyway.
  Files are untouched, so `systemctl enable --now apache2` undoes it.
- **dnsmasq `bind-dynamic`.** Its config says `interface=wlan0`, but without a bind directive it
  still listens on `*:53` and will answer the house LAN as an open resolver. `bind-dynamic` rather
  than `bind-interfaces` because wlan0's IP is assigned late — `bind-interfaces` would race it.
- **avahi restricted to the AP**, so the board stops advertising itself across the house.

## 3. Firewall — `ledbox-firewall.sh` + `install-firewall.sh`

Default-deny INPUT with per-interface allows, ordered by trust: `wlan1` (house LAN) least,
then `eth0` (link to the Pi), then `wlan0` (the board's own AP, where the console tablet lives),
then `lo` (the bridge reaches the panel at `LEDBOX_HOST=127.0.0.1:8889` through here).

This is not a theoretical concern. Within five minutes of one board joining a home LAN it was
probed with ONVIF, RTSP and Log4Shell JNDI payloads — from the router itself, so near-certainly a
consumer security suite auto-scanning a new device, but it makes the point.

```bash
sudo ./install-firewall.sh              # applies, with a 240s auto-rollback armed
# ... verify from another machine ...
sudo ./install-firewall.sh --commit     # disarms the rollback
sudo ./install-firewall.sh --rollback-now   # or undo immediately
```

**Applying a default-deny policy over SSH is the classic way to brick a remote device**, so the
installer snapshots the current rules and arms a detached timer that restores them unless you
commit. If the new rules cut your own access, the board recovers by itself.

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

Installed as a **systemd unit, not a hand-added rule.** A hand-added `iptables` rule is precisely
what silently disappeared on a reboot once and took the board's clock with it.

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
