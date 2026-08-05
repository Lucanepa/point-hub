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
    python3 docs/make-hall-guide.py --pdf                 # ...and print-ready PDFs beside them
    python3 docs/make-hall-guide.py --wifi-pass 'secret'  # or pass the passphrase explicitly
    python3 docs/make-hall-guide.py --only card --pdf     # just one of them
    python3 docs/make-hall-guide.py -o /tmp/guide.html    # preview the guide somewhere else

Then print the PDF (or the HTML from a browser): guide A4, card A5 double-sided flipped on the
SHORT edge. Deps: qrcode + Pillow, same as firmware/idle-crest-qr/gen_qr.py (which renders the
much smaller 48px panel version); --pdf additionally needs Chrome or Chromium.
"""
import argparse
import base64
import io
import os
import shutil
import subprocess
import sys
import tempfile

SSID = "ledbox_C0270"
VAULT_ITEM = "LedBox - ledbox_C0270 WiFi (Tech4Sport)"
HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "hall-guide.template.html")
DEFAULT_OUT = os.path.join(HERE, "hall-guide.html")

# name -> (template, html output, pdf output). All of these carry the passphrase as text AND as an
# inline wifi QR, so all of them are credentials and all of them are gitignored. Adding a fourth
# artefact means adding a gitignore line in the same commit — the check in render_all() enforces
# that for every path it is about to write, PDFs included.
ARTEFACTS = {
    "guide": ("hall-guide.template.html", "hall-guide.html", "hall-guide.pdf"),
    "card": ("hall-card.template.html", "hall-card.html", "hall-card.pdf"),
}

# Chrome is the renderer because it is the browser these were designed and proof-read in, so the
# PDF matches the on-screen proof exactly — @page size/margins, the flex QR rows and the
# page-break-inside rules all behave the way they already did. It prints in the PRINT media type,
# so the @media screen framing in the templates is correctly absent from the PDF.
CHROMES = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser",
           "/opt/google/chrome/chrome", "/snap/bin/chromium"]

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


def find_chrome():
    for c in CHROMES:
        p = c if os.path.isabs(c) else shutil.which(c)
        if p and os.path.exists(p):
            return p
    return None


def to_pdf(chrome, html_path, pdf_path):
    """Print an already-rendered HTML file to PDF.

    Chrome writes the output file itself, and it writes it 0644 — on a credential that is the
    wrong mode and there is no flag to change it. So it renders into a 0700 temp dir and the
    result is moved into place with the mode set BEFORE it lands anywhere world-readable.
    """
    with tempfile.TemporaryDirectory() as tmp:
        os.chmod(tmp, 0o700)
        staged = os.path.join(tmp, "out.pdf")
        r = subprocess.run([
            chrome, "--headless", "--disable-gpu",
            # Its own profile: without this it refuses to start when the user's Chrome is running,
            # which on a desktop machine is nearly always.
            "--user-data-dir=" + os.path.join(tmp, "profile"),
            # Chrome's own date/URL header and page-number footer would otherwise be stamped over
            # the templates' carefully-set @page margins.
            "--no-pdf-header-footer",
            "--print-to-pdf=" + staged,
            "file://" + os.path.abspath(html_path),
        ], capture_output=True, text=True, timeout=120)
        if r.returncode != 0 or not os.path.exists(staged):
            sys.exit(f"chrome failed to render {pdf_path}:\n{r.stderr.strip()[:500]}")
        os.chmod(staged, 0o600)
        shutil.move(staged, pdf_path)
    print(f"wrote {pdf_path} (mode 0600) — printable, and NOT to be committed")


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
    ap.add_argument("--pdf", action="store_true", help="also print each artefact to PDF via Chrome")
    a = ap.parse_args()

    passphrase = a.wifi_pass or from_vault()
    if not passphrase:
        sys.exit("empty passphrase — refusing to render a guide that cannot work")

    wanted = [a.only] if a.only else sorted(ARTEFACTS)
    if a.out and len(wanted) > 1:
        sys.exit("-o needs --only: two artefacts cannot share one output path")

    chrome = None
    if a.pdf:
        chrome = find_chrome()
        if not chrome:
            sys.exit("--pdf needs Chrome or Chromium on PATH; tried: " + ", ".join(CHROMES))

    # One QR render shared by both — same SSID, same passphrase, so two renders could only differ
    # by being out of step with each other.
    qr_uri = wifi_qr_data_uri(SSID, passphrase)

    for name in wanted:
        template, default_out, default_pdf = ARTEFACTS[name]
        out = a.out or os.path.join(HERE, default_out)
        if not os.path.exists(os.path.join(HERE, template)):
            sys.exit(f"missing template {template} — cannot render {name}")
        # Checked for every path about to be written, and checked BEFORE writing any of them.
        outs = [out] + ([os.path.join(HERE, default_pdf)] if a.pdf else [])
        for p in outs:
            if not gitignored(p):
                sys.exit(f"REFUSING to write {p}: git would track it, and it carries the "
                         f"passphrase.\nAdd it to .gitignore first — see the hall-guide.html "
                         f"entry for why.")
        render(os.path.join(HERE, template), out, qr_uri, passphrase)
        if a.pdf:
            to_pdf(chrome, out, os.path.join(HERE, default_pdf))


if __name__ == "__main__":
    main()
