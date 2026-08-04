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

## 2. Firewall for the uplink — `install-lan-guard.sh`

Joining a real LAN exposes services that were previously only reachable on the point-to-point link
and the board's own AP. Everything on the board binds `0.0.0.0` and there is no INPUT policy: the
vendor's apache admin on `:80` (default credentials), raw scoreboard control on `:8889` and
`:12345`, and dnsmasq on `:53` as an open resolver.

This is not theoretical. Within five minutes of one board joining a home LAN it was probed with
ONVIF, RTSP and Log4Shell JNDI payloads — from the router itself, so near-certainly a consumer
security suite auto-scanning a new device, but it makes the point.

```bash
sudo ./install-lan-guard.sh
```

DROPs `:80,:8889,:12345,:53` **on `-i wlan1` only**, v4 and v6. The AP subnet, the cabled link and
tailscale are untouched, so the vendor admin stays reachable exactly as before — this restricts a
newly gained exposure rather than removing existing access. `:8890` (the console, PIN-protected)
and `:22` stay open on the LAN deliberately, so the console works from a device on house wifi
without joining the board's AP.

Installed as a **systemd unit, not a hand-added rule.** A hand-added `iptables` rule is precisely
what silently disappeared on a reboot once and took the board's clock with it. Idempotent
(`-C || -A`), safe to re-run.

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
