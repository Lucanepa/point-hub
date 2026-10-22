#!/bin/bash
# Wi-Fi regulatory domain CH on both radios, and the AP's country/WMM settings.
#
# Nothing on the board sets a country today (grep: no regdom/country_code anywhere in provisioning),
# so the radios run on the kernel's world domain "00" and the AP advertises no country at all. For
# a Swiss hall that is the wrong domain for both radios (gap-01: the radio part of NEV/FAV
# conformity), and it is what the hall Wi-Fi a 5 GHz uplink associates with.
#
# Two places, one step each:
#   hostapd  the AP (built-in brcmfmac, wlan0). Sets country_code=CH, ieee80211d=1 (advertise it)
#            and wmm_enabled=1 (802.11n needs WMM; without it the AP falls back to 11g rates).
#            Every other line of the vendor's hostapd config stays as it is. The config is found
#            the way hostapd is started (DAEMON_CONF in /etc/default/hostapd, the unit's command
#            line, else /etc/hostapd/hostapd.conf — REVIEW-2026-08-04 found that to be the only
#            one on the board). Restarting hostapd drops the AP for a few seconds: run it over the
#            tailnet or the cable, never from a laptop on the AP — it refuses that (FORCE=1 to
#            override). If hostapd does not come back, the old config is put back at once.
#   regdom   cfg80211.ieee80211_regdom=CH on the kernel command line, so BOTH radios start in CH
#            from boot (wlan1, the USB client, joins before hostapd ever runs). This is what
#            raspi-config's "WLAN country" does on bookworm. Needs a reboot; same cmdline.txt care
#            as setup-quiet-core.sh (token-wise edit, validated, copy kept on the FAT partition).
#
# The AP stays on 2.4 GHz (provisioning/README.md: AP 2.4 / client 5 GHz, separate radios). This
# refuses to touch an AP configured for 5 GHz — channel rules there need DFS thinking first.
#
# The vendor app also has Wi-Fi settings (its config protocol and the now-disabled web UI). If its
# code rewrites the hostapd config, a vendor Wi-Fi change could undo this; --check greps the vendor
# tree for that and says so. Re-run --check after any vendor Wi-Fi change.
#
#   sudo bash ledbox-bridge/provisioning/setup-wifi-country.sh                 # --check: read-only
#   sudo bash ledbox-bridge/provisioning/setup-wifi-country.sh --apply hostapd
#   sudo bash ledbox-bridge/provisioning/setup-wifi-country.sh --apply regdom  # then: sudo reboot
#   sudo bash ledbox-bridge/provisioning/setup-wifi-country.sh --rollback      # undoes the last run
#
# Never prints the passphrase: only a fixed list of non-secret keys is shown.
set -uo pipefail

LP_NAME=setup-wifi-country
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
. "$HERE/lib-provision.sh" || { echo "!! lib-provision.sh missing next to $0"; exit 1; }

ALL="hostapd regdom"
MODE=${1:---check}
shift || true
STEPS=${*:-$ALL}
for s in $STEPS; do case " $ALL " in *" $s "*) ;; *) echo "!! unknown step '$s' (steps: $ALL)"; exit 2 ;; esac; done
case "$MODE" in --check|--apply|--rollback) ;; *) sed -n '2,35p' "$0"; exit 2 ;; esac
lp_need_root "$MODE"

COUNTRY=CH
SHOW_KEYS="interface driver ssid hw_mode channel country_code ieee80211d ieee80211h ieee80211n ieee80211ac wmm_enabled ieee80211w ap_isolate wpa wpa_key_mgmt rsn_pairwise ctrl_interface"
RC=0

hostapd_conf() {
  local c=""
  [ -f /etc/default/hostapd ] && c=$(sed -n 's/^[[:space:]]*DAEMON_CONF=["]\{0,1\}\([^"]*\)["]\{0,1\}.*/\1/p' /etc/default/hostapd | tail -1)
  [ -z "$c" ] && c=$(systemctl show -p ExecStart --value hostapd 2>/dev/null | grep -o '/[^ ;]*\.conf' | head -1)
  [ -z "$c" ] && c=/etc/hostapd/hostapd.conf
  echo "$c"
}
val() { sed -n "s/^[[:space:]]*$1=//p" "$2" | tail -1; }

check_hostapd() {
  say "hostapd (the AP on wlan0)"
  local c; c=$(hostapd_conf)
  echo "  config: $c   hostapd: $(systemctl is-active hostapd 2>/dev/null)"
  [ -f "$c" ] || { echo "  !! $c does not exist"; RC=1; return; }
  local k v
  for k in $SHOW_KEYS; do
    v=$(val "$k" "$c")
    [ -n "$v" ] && printf '  %-14s %s\n' "$k" "$v"
  done
  [ "$(val country_code "$c")" = "$COUNTRY" ] && [ "$(val ieee80211d "$c")" = 1 ] && [ "$(val wmm_enabled "$c")" = 1 ] \
    && echo "  → already CH / 802.11d / WMM" || echo "  → --apply hostapd sets country_code=$COUNTRY ieee80211d=1 wmm_enabled=1"
  local hits
  hits=$(grep -rlas -e 'hostapd' /home/pi/ledbox --include='*.py' --include='*.pyc' --include='*.sh' --include='*.php' 2>/dev/null; \
         grep -las -e 'hostapd' /home/pi/ledbox/bin/* 2>/dev/null)
  if [ -n "$hits" ]; then
    echo "  !! vendor files mention hostapd — a vendor Wi-Fi change may rewrite the config:"
    sort -u <<<"$hits" | head -8 | sed 's/^/       /'
  else
    echo "  vendor tree: nothing mentions hostapd"
  fi
}

check_regdom() {
  say "regulatory domain (both radios)"
  local dir; dir=$(lp_bootdir) && echo "  cmdline.txt: $(grep -o 'cfg80211.ieee80211_regdom=[A-Z0-9]*' "$dir/cmdline.txt" || echo 'no cfg80211.ieee80211_regdom')"
  echo "  cfg80211 module parameter: $(cat /sys/module/cfg80211/parameters/ieee80211_regdom 2>/dev/null || echo '?')   ('00' = world)"
  if command -v iw >/dev/null; then iw reg get 2>/dev/null | grep -E '^(global|phy|country)' | sed 's/^/  iw: /'
  else echo "  (iw is not installed on this board; the kernel log says:)"; fi
  dmesg 2>/dev/null | grep -iE 'cfg80211.*(regulatory|regdom|country)|brcmfmac.*(ccode|country)|regulatory domain' | tail -4 | sed 's/^/  /'
}

apply_hostapd() {
  say "hostapd — country_code=$COUNTRY, ieee80211d=1, wmm_enabled=1"
  local c; c=$(hostapd_conf)
  [ -f "$c" ] || { echo "  !! $c does not exist"; RC=1; return; }
  local mode; mode=$(val hw_mode "$c")
  if [ -n "$mode" ] && [ "$mode" != g ] && [ "${FORCE:-0}" != 1 ]; then
    echo "  !! hw_mode=$mode — this AP is not on 2.4 GHz; channel rules differ there. Not touching it (FORCE=1)."; RC=1; return
  fi
  local ch; ch=$(val channel "$c")
  case "$ch" in ''|0|[1-9]|1[0-3]) ;; *) echo "  !! channel=$ch is not a CH 2.4 GHz channel (1-13) — fix that first"; RC=1; return ;; esac
  # What would change, before anything is written.
  local tmp; tmp=$(mktemp) || { RC=1; return; }
  cp -a "$c" "$tmp"
  local kv k v
  for kv in country_code=$COUNTRY ieee80211d=1 wmm_enabled=1; do
    k=${kv%%=*}; v=${kv#*=}
    if grep -qE "^[[:space:]]*$k=" "$tmp"; then
      # Replace the first, drop any later duplicates (hostapd would take the last one silently).
      awk -v k="$k" -v v="$v" 'BEGIN{d=0} $0 ~ "^[[:space:]]*" k "=" { if (!d) { print k "=" v; d=1 } ; next } { print }' "$tmp" > "$tmp.n" \
        && cat "$tmp.n" > "$tmp" && rm -f "$tmp.n"
    else
      printf '%s=%s\n' "$k" "$v" >> "$tmp"
    fi
  done
  if cmp -s "$tmp" "$c"; then rm -f "$tmp"; echo "  already set — nothing written"; return; fi
  diff -U0 "$c" "$tmp" | grep -E '^[+-][a-z0-9_]+=' | grep -vE '^[+-](wpa_passphrase|wpa_psk|sae_password)=' | sed 's/^/  /'
  local dev; dev=$(lp_session_dev)
  if [ "$dev" = wlan0 ] && [ "${FORCE:-0}" != 1 ]; then
    rm -f "$tmp"
    echo "  !! this session comes in over wlan0 — the AP this restarts. Run it over the tailnet or the cable (FORCE=1 to insist)."
    RC=1; return
  fi
  lp_bak "$c" || { rm -f "$tmp"; RC=1; return; }
  cat "$tmp" > "$c" && rm -f "$tmp"     # cat >, not mv: keeps the file's owner and 0600
  systemctl restart hostapd
  sleep 4
  if systemctl is-active --quiet hostapd; then
    echo "  hostapd restarted: active"
    command -v hostapd_cli >/dev/null && hostapd_cli -i wlan0 status 2>/dev/null | grep -E '^(state|channel|country_code|ieee80211n)=' | sed 's/^/  /'
  else
    echo "  !! hostapd did NOT come back — putting the old config back now"
    journalctl -u hostapd -n 8 --no-pager 2>/dev/null | sed 's/^/     /'
    lp_restore >/dev/null && systemctl restart hostapd
    echo "  hostapd after restore: $(systemctl is-active hostapd)"
    RC=1
  fi
}

apply_regdom() {
  say "regdom — cfg80211.ieee80211_regdom=$COUNTRY on the kernel command line"
  lp_cmdline_edit "cfg80211.ieee80211_regdom=$COUNTRY" "" || { RC=1; return; }
  echo "  takes effect at the next reboot"
}

case "$MODE" in
  --check) for s in $STEPS; do "check_$s"; done ;;
  --apply)
    for s in $STEPS; do "apply_$s"; done
    [ -n "$LP_RUN" ] && echo $'\n'"  backups: $LP_RUN   (undo: --rollback)"
    ;;
  --rollback)
    say "rollback — the newest $LP_NAME run"
    run=$(ls -1d "$LP_BACKUPS/$LP_NAME"-2* 2>/dev/null | grep -v '\.rolled-back$' | sort | tail -1)
    if [ -n "$run" ] && grep -q 'hostapd' "$run/PATHS" 2>/dev/null && [ "$(lp_session_dev)" = wlan0 ] && [ "${FORCE:-0}" != 1 ]; then
      echo "  !! this restarts hostapd and this session comes in over wlan0 — use the tailnet or the cable (FORCE=1)"; exit 1
    fi
    lp_restore || RC=1
    if [ -n "$run" ] && grep -q 'hostapd' "$run/PATHS" 2>/dev/null; then
      systemctl restart hostapd; sleep 3; echo "  hostapd: $(systemctl is-active hostapd)"
    fi
    [ -n "$run" ] && grep -q 'cmdline.txt' "$run/PATHS" 2>/dev/null && echo "  cmdline.txt restored — reboot to take effect"
    ;;
esac
exit "$RC"
