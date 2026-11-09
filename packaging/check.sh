#!/usr/bin/env bash
# Offline checks of the package manager files: each one parses, names the same
# version, points at that version's release asset and carries a real checksum.
#
#   packaging/check.sh          offline
#   packaging/check.sh --urls   also asks GitHub that every installer URL answers
#
# Needs python3 with PyYAML.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd -P)
root=$(cd "$here/.." && pwd -P)
urls=0
case ${1:-} in --urls) urls=1 ;; '') ;; *) echo "usage: $0 [--urls]" >&2; exit 2 ;; esac

python3 - "$root" "$urls" <<'PY'
import json, pathlib, re, sys, urllib.request
import yaml

root, check_urls = pathlib.Path(sys.argv[1]), sys.argv[2] == "1"
REL = "https://github.com/Lucanepa/point-hub/releases/download/desktop-v"
HEX = re.compile(r"^[0-9a-f]{64}$")
GUID = re.compile(r"^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$")
errors, versions, urls = [], {}, []

def need(ok, msg):
    if not ok:
        errors.append(msg)

# Scoop
m = json.loads((root / "bucket/point-hub.json").read_text(encoding="utf-8"))
v = m["version"]; versions["Scoop"] = v
a = m["architecture"]["64bit"]
need(a["url"] == f"{REL}{v}/point-hub-{v}.msi#/point-hub.msi_", f"Scoop: url {a['url']}")
need(bool(HEX.match(a["hash"])), f"Scoop: hash {a['hash']}")
need("$version" in m["autoupdate"]["architecture"]["64bit"]["url"], "Scoop: autoupdate url without $version")
urls.append(a["url"].split("#")[0])

# Homebrew
c = (root / "Casks/point-hub.rb").read_text(encoding="utf-8")
cv = re.search(r'(?m)^  version "([^"]+)"$', c)
need(cv is not None, "Homebrew: no version line")
if cv:
    versions["Homebrew"] = cv.group(1)
    for arch, pat in (("arm64", r'(?m)^  sha256 arm:   "([^"]*)",$'), ("x64", r'(?m)^         intel: "([^"]*)"$')):
        s = re.search(pat, c)
        need(bool(s and HEX.match(s.group(1))), f"Homebrew: sha256 {arch}")
        urls.append(f"{REL}{cv.group(1)}/Point-Hub-{cv.group(1)}-macos-{arch}.dmg")
app = re.search(r'(?m)^  app "([^"]+\.app)"$', c)
need(app is not None, "Homebrew: no app line")
if app:
    need(f'"/Applications/{app.group(1)}"' in c, "Homebrew: the caveats name another app")
need("auto_updates" not in c.replace("# No auto_updates", ""), "Homebrew: auto_updates (Point Hub has no updater)")

# winget: one version, three files that agree
wbase = root / "packaging/winget/manifests/k/KSCWiedikon/PointHub"
dirs = [d for d in wbase.iterdir() if d.is_dir()]
need(len(dirs) == 1, f"winget: expected one version folder, found {[d.name for d in dirs]}")
for d in dirs:
    versions["winget"] = d.name
    docs = {}
    for kind, name in (("version", "KSCWiedikon.PointHub.yaml"),
                       ("installer", "KSCWiedikon.PointHub.installer.yaml"),
                       ("defaultLocale", "KSCWiedikon.PointHub.locale.en-US.yaml")):
        f = d / name
        need(f.is_file(), f"winget: missing {name}")
        if f.is_file():
            y = yaml.safe_load(f.read_text(encoding="utf-8"))
            docs[kind] = y
            need(y.get("ManifestType") == kind, f"winget: {name} ManifestType {y.get('ManifestType')}")
            need(y.get("PackageIdentifier") == "KSCWiedikon.PointHub", f"winget: {name} PackageIdentifier")
            need(str(y.get("PackageVersion")) == d.name, f"winget: {name} PackageVersion {y.get('PackageVersion')}")
    i = docs.get("installer")
    if i:
        inst = i["Installers"][0]
        need(inst["InstallerUrl"] == f"{REL}{d.name}/point-hub-{d.name}.msi", f"winget: InstallerUrl {inst['InstallerUrl']}")
        need(bool(re.match(r"^[0-9A-F]{64}$", str(inst["InstallerSha256"]))), "winget: InstallerSha256")
        need(bool(GUID.match(str(i.get("ProductCode", "")))), "winget: ProductCode")
        e = i["AppsAndFeaturesEntries"][0]
        need(e.get("ProductCode") == i.get("ProductCode"), "winget: the two ProductCodes differ")
        need(e.get("UpgradeCode") == "{6F0C3A2E-6C7B-4D44-9A3E-2F5A8E1B7C10}", "winget: UpgradeCode")
        if "Scoop" in versions and versions["Scoop"] == d.name:
            need(str(inst["InstallerSha256"]).lower() == a["hash"], "winget and Scoop: different .msi checksums")
        urls.append(inst["InstallerUrl"])

# AUR: PKGBUILD and .SRCINFO agree
pb = (root / "packaging/aur/point-hub-bin/PKGBUILD").read_text(encoding="utf-8")
si = (root / "packaging/aur/point-hub-bin/.SRCINFO").read_text(encoding="utf-8")
pv = re.search(r"(?m)^pkgver=(\S+)$", pb).group(1); versions["AUR"] = pv
pr = re.search(r"(?m)^pkgrel=(\S+)$", pb).group(1)
need(re.search(rf"(?m)^\tpkgver = {re.escape(pv)}$", si) is not None, "AUR: .SRCINFO pkgver differs from PKGBUILD")
need(re.search(rf"(?m)^\tpkgrel = {re.escape(pr)}$", si) is not None, "AUR: .SRCINFO pkgrel differs from PKGBUILD")
for key in ("sha256sums", "sha256sums_x86_64"):
    s = re.search(rf"(?m)^{key}=\('([^']*)'\)$", pb)
    need(bool(s and HEX.match(s.group(1))), f"AUR: {key}")
    if s:
        need(f"\t{key} = {s.group(1)}" in si, f"AUR: .SRCINFO {key} differs from PKGBUILD")
urls.append(f"{REL}{pv}/point-hub_{pv}_amd64.deb")

need(len(set(versions.values())) == 1, f"the channels name different versions: {versions}")

if check_urls:
    for u in urls:
        try:
            req = urllib.request.Request(u, method="HEAD", headers={"User-Agent": "point-hub-packaging-check"})
            with urllib.request.urlopen(req, timeout=30) as r:
                need(r.status == 200, f"{u}: HTTP {r.status}")
        except Exception as ex:  # noqa: BLE001
            errors.append(f"{u}: {ex}")

if errors:
    print("packaging check FAILED:", *errors, sep="\n  ", file=sys.stderr)
    sys.exit(1)
print(f"packaging check: Scoop, Homebrew, winget, AUR all at {versions['Scoop']}" + (", URLs answer" if check_urls else ""))
PY
