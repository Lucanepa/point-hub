#!/usr/bin/env bash
# Give the console a real certificate, so the tablet gets a secure context.
#
# WHY THIS EXISTS
# The Screen Wake Lock API is secure-context only. On http://172.24.1.1:8890 navigator.wakeLock
# does not exist on ANY browser, so the console falls back to playing a silent looping video to
# keep the screen lit — a workaround for a missing origin property, not a missing feature. Service
# workers and PWA install are gated the same way.
#
# The board is already a Tailscale node, so `tailscale cert` issues a genuine Let's Encrypt
# certificate for its tailnet name with no public DNS and no port forwarding. A dnsmasq address=
# record then answers that name with the AP address, which is what makes a publicly-trusted
# certificate work in a hall with no internet.
#
# STRICTLY ADDITIVE. Plain HTTP on :8890 is the contract — the QR on the panel, the printed hall
# guide and every operator's memory point at it — and nothing here touches it. If the certificate
# is missing, unreadable or expired the appliance logs a warning and serves HTTP exactly as before.
#
#   sudo ./setup-console-tls.sh              # issue, wire up, enable renewal
#   sudo ./setup-console-tls.sh --check      # report state, change nothing
#
# Run it ON THE BOARD. Needs tailscaled up and internet ONCE (to issue); after that the hall needs
# neither.
set -uo pipefail

CERT_DIR=/etc/ledbox-tls
CERT=$CERT_DIR/board.crt
KEY=$CERT_DIR/board.key
DNSMASQ_CONF=/etc/dnsmasq.d/ledbox-https.conf
ENV_FILE=/home/pi/ledbox-bridge/.env
AP_IP=172.24.1.1
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

[ "$(id -u)" = 0 ] || { echo "!! must run as root — try: sudo $0"; exit 1; }

say() { printf '\n== %s ==\n' "$1"; }
RC=0

# The tailnet name is DERIVED, never hardcoded: this repo is public and addresses do not belong in
# it, the same reasoning as the SSH alias in deploy-board.sh.
say "1. tailnet name"
DOMAIN=$(tailscale status --json 2>/dev/null | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null)
if [ -z "$DOMAIN" ]; then
  echo "  !! no tailnet DNS name — is tailscaled up? (tailscale status)"
  exit 1
fi
echo "  $DOMAIN"

say "2. certificate"
if [ "$CHECK" = 1 ]; then
  if [ -s "$CERT" ]; then
    openssl x509 -in "$CERT" -noout -subject -dates 2>/dev/null || { echo "  !! unreadable"; RC=1; }
  else
    echo "  (none issued)"; RC=1
  fi
else
  mkdir -p "$CERT_DIR"
  # A no-op when the cert is not yet inside its renewal window, so this is safe to re-run.
  if tailscale cert --cert-file "$CERT" --key-file "$KEY" "$DOMAIN"; then
    # The appliance runs as pi and must be able to read the key.
    chown pi:pi "$CERT" "$KEY"
    chmod 644 "$CERT"
    chmod 600 "$KEY"
    echo "  ok"
  else
    echo "  !! issuance failed — is 'HTTPS Certificates' enabled for this tailnet in the admin console?"
    exit 1
  fi
fi

say "3. dnsmasq record (so the name resolves on the AP with no internet)"
WANT="address=/$DOMAIN/$AP_IP"
if grep -qsF "$WANT" "$DNSMASQ_CONF"; then
  echo "  already present"
elif [ "$CHECK" = 1 ]; then
  echo "  !! missing — the certificate name will not resolve on the AP"; RC=1
else
  cat > "$DNSMASQ_CONF" <<EOF
# The console is also served over TLS on 8891. The certificate is issued for this name, so the
# tablet must reach it BY NAME — but MagicDNS needs internet and the hall has none. Answering
# locally is what makes a real, publicly-trusted certificate work on an isolated AP.
$WANT
EOF
  systemctl restart dnsmasq && echo "  written, dnsmasq restarted" || { echo "  !! dnsmasq restart FAILED"; RC=1; }
fi

say "4. appliance environment"
for pair in "TLS_CERT=$CERT" "TLS_KEY=$KEY"; do
  k=${pair%%=*}
  if grep -qs "^$k=" "$ENV_FILE"; then
    echo "  $k already set"
  elif [ "$CHECK" = 1 ]; then
    echo "  !! $k missing from $ENV_FILE — the listener will not start"; RC=1
  else
    echo "$pair" >> "$ENV_FILE" && echo "  $k added"
  fi
done

say "5. renewal timer"
if systemctl is-enabled ledbox-tls-renew.timer >/dev/null 2>&1; then
  echo "  enabled — next: $(systemctl list-timers ledbox-tls-renew --no-pager 2>/dev/null | awk 'NR==2{print $1,$2,$3}')"
elif [ "$CHECK" = 1 ]; then
  echo "  !! not enabled — the certificate will expire in ~90 days and stay expired"; RC=1
else
  echo "  !! install systemd/ledbox-tls-renew.{service,timer} first, then:"
  echo "     systemctl daemon-reload && systemctl enable --now ledbox-tls-renew.timer"
  RC=1
fi

say "6. firewall"
if iptables -C LEDBOX-IN -i wlan0 -p tcp --dport 8891 -j ACCEPT 2>/dev/null; then
  echo "  8891 open on wlan0 (the AP)"
else
  echo "  !! 8891 NOT open on wlan0 — re-run provisioning/ledbox-firewall.sh"; RC=1
fi

say "result"
if [ "$RC" = 0 ]; then
  echo "  https://$DOMAIN:8891  — restart the appliance to pick it up:"
  echo "    sudo systemctl restart ledbox-bridge"
else
  echo "  incomplete — see the !! lines above. HTTP on :8890 is unaffected either way."
fi
exit $RC
