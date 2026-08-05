#!/usr/bin/env python3
"""Render the printable hall guide from docs/hall-guide.template.html.

The guide has to carry the board's Wi-Fi passphrase — a volunteer scanning a QR at the side of a
court is the whole point of it. That makes the *finished* guide a credential, so only the template
lives in git and the filled-in copy is generated on demand and gitignored.

This is not hypothetical bookkeeping. The passphrase was published twice before: once as a committed
`wifi_qr.png` (the image IS the credential), and once as an inline `data:image/png;base64,` blob in
this very guide, which sailed straight past the `firmware/**/wifi_qr.png` gitignore rule because
that rule matches a *path* and the secret had taken a different one. Hence: template in, artefact
out, and the artefact never gets a filename git is willing to track.

Renders TWO artefacts from the same passphrase, because they leak the same way and would
otherwise drift apart:
  hall-guide.html  A4, the full guide.
  hall-card.html   A5 double-sided, the laminated card that lives with the board.

    python3 docs/make-hall-guide.py                      # both, passphrase from Vaultwarden
    python3 docs/make-hall-guide.py --wifi-pass 'secret'  # or pass it explicitly
    python3 docs/make-hall-guide.py --only card           # just one of them
    python3 docs/make-hall-guide.py -o /tmp/guide.html    # preview the guide somewhere else

Then print it to A4 from a browser. Deps: qrcode + Pillow, same as
firmware/idle-crest-qr/gen_qr.py (which renders the much smaller 48px panel version).
"""
import argparse
import base64
import io
import os
import subprocess
import sys

SSID = "ledbox_C0270"
VAULT_ITEM = "LedBox - ledbox_C0270 WiFi (Tech4Sport)"
HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "hall-guide.template.html")
DEFAULT_OUT = os.path.join(HERE, "hall-guide.html")

# name -> (template, default output). Both carry the passphrase as text AND as an inline wifi QR,
# so both are credentials and both are gitignored. Adding a third artefact means adding a
# gitignore line in the same commit — the check at the bottom of main() enforces that.
ARTEFACTS = {
    "guide": ("hall-guide.template.html", "hall-guide.html"),
    "card": ("hall-card.template.html", "hall-card.html"),
}

# Print, not LED panel: this one is read by a phone camera off paper, so it wants a real quiet zone
# and enough modules to survive a mediocre print. Nothing here is shared with gen_qr.py's 48px
# panel constants on purpose — they are solving different problems.
PX = 240
BORDER = 3


def wifi_qr_data_uri(ssid, passphrase):
    try:
        import qrcode
        from qrcode.constants import ERROR_CORRECT_M
    except ImportError:
        sys.exit("missing deps: pip install qrcode pillow")
    # Escape the WIFI: URI metacharacters, or a passphrase containing ; , : or \ silently encodes
    # a different network than the one printed underneath it.
    esc = lambda s: "".join("\\" + c if c in "\\;,:\"" else c for c in s)
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, border=BORDER)
    qr.add_data(f"WIFI:T:WPA;S:{esc(ssid)};P:{esc(passphrase)};;")
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").resize((PX, PX))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def from_vault():
    try:
        out = subprocess.run(["rbw", "get", VAULT_ITEM], capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        sys.exit("rbw not found — install it, or pass --wifi-pass")
    if out.returncode != 0:
        sys.exit(f"rbw failed (locked? run `rbw unlock`): {out.stderr.strip()}")
    return out.stdout.strip()


def render(template_path, out_path, qr_uri, passphrase):
    with open(template_path, encoding="utf-8") as fh:
        html = fh.read()
    html = html.replace("{{WIFI_QR}}", qr_uri)
    html = html.replace("{{WIFI_PASS}}", passphrase)
    if "{{" in html:
        sys.exit(f"unfilled placeholder left in {out_path} — template and script are out of step")

    # 0600: this file is a credential from the moment it is written.
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(html)
    print(f"wrote {out_path} (mode 0600) — printable, and NOT to be committed")


def gitignored(path):
    """True if git will refuse to track `path`. A rendered artefact that git WOULD track is the
    exact failure this whole template/artefact split exists to prevent, and it has happened twice
    — so it is checked rather than trusted."""
    try:
        r = subprocess.run(["git", "check-ignore", "-q", path], cwd=HERE, timeout=10)
        return r.returncode == 0
    except (FileNotFoundError, subprocess.SubprocessError):
        return True  # no git here: not our problem to diagnose, and not a reason to refuse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wifi-pass", help="AP passphrase; read from Vaultwarden when omitted")
    ap.add_argument("--only", choices=sorted(ARTEFACTS), help="render just one artefact")
    ap.add_argument("-o", "--out", help="output path; only valid with --only (or for the guide)")
    a = ap.parse_args()

    passphrase = a.wifi_pass or from_vault()
    if not passphrase:
        sys.exit("empty passphrase — refusing to render a guide that cannot work")

    wanted = [a.only] if a.only else sorted(ARTEFACTS)
    if a.out and len(wanted) > 1:
        sys.exit("-o needs --only: two artefacts cannot share one output path")

    # One QR render shared by both — same SSID, same passphrase, so two renders could only differ
    # by being out of step with each other.
    qr_uri = wifi_qr_data_uri(SSID, passphrase)

    for name in wanted:
        template, default_out = ARTEFACTS[name]
        out = a.out or os.path.join(HERE, default_out)
        if not os.path.exists(os.path.join(HERE, template)):
            sys.exit(f"missing template {template} — cannot render {name}")
        if not gitignored(out):
            sys.exit(f"REFUSING to write {out}: git would track it, and it carries the passphrase.\n"
                     f"Add it to .gitignore first — see the hall-guide.html entry for why.")
        render(os.path.join(HERE, template), out, qr_uri, passphrase)


if __name__ == "__main__":
    main()
