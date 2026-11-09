#!/usr/bin/env bash
# Points every package manager at a desktop release of Point Hub: the Scoop
# bucket (bucket/point-hub.json), the Homebrew tap (Casks/point-hub.rb), winget
# (packaging/winget/manifests/k/KSCWiedikon/PointHub/VERSION/) and the AUR
# (packaging/aur/point-hub-bin/PKGBUILD and .SRCINFO).
#
#   packaging/bump.sh VERSION [PKGREL]
#
# Run it after .github/workflows/desktop.yml published the GitHub release
# desktop-vVERSION (a draft or a prerelease is refused). It downloads the .msi,
# the .deb and both .dmg once (about 800 MB), checks what they are, and writes
# their checksums. Then: packaging/check.sh, commit, merge to main (Scoop and
# Homebrew read main), and submit winget and the AUR (packaging/README.md).
#
#   PKGREL                  the AUR pkgrel (default 1; 2, 3... for a fix of
#                           the PKGBUILD with the same release)
#   POINTHUB_RELEASE_DIR    a folder that already holds the release's files
#                           (point-hub-VERSION.msi, point-hub_VERSION_amd64.deb,
#                           Point-Hub-VERSION-macos-{arm64,x64}.dmg, LICENSE):
#                           nothing is downloaded; the release date is the
#                           release's when gh finds it, else today
#
# Needs curl, sha256sum, dpkg-deb, 7z, python3; msiinfo (msitools) or docker
# for the .msi; makepkg or docker for .SRCINFO; gh for the release check.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd -P)
root=$(cd "$here/.." && pwd -P)
REPO=Lucanepa/point-hub
APP_ID=ch.kscw.pointhub
# Fixed for good in android/desktop/build.gradle.kts: a new .msi with it
# replaces the installed version (major upgrade).
UPGRADE_CODE='{6F0C3A2E-6C7B-4D44-9A3E-2F5A8E1B7C10}'
WINGET_ID=KSCWiedikon.PointHub
MANIFEST_VERSION=1.28.0
die() { echo "bump: $*" >&2; exit 1; }

[[ $# -ge 1 && $# -le 2 ]] || die "usage: $0 VERSION [PKGREL]"
v=${1#v} rel=${2:-1}
[[ $v =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "version must look like 1.2.0, got '$v'"
[[ $rel =~ ^[1-9][0-9]*$ ]] || die "pkgrel must be a positive number, got '$rel'"
tag=desktop-v$v
base_url=https://github.com/$REPO/releases/download/$tag
for t in curl sha256sum dpkg-deb 7z python3; do command -v "$t" >/dev/null || die "$t not found"; done

msi=point-hub-$v.msi deb=point-hub_${v}_amd64.deb
dmg_arm64=Point-Hub-$v-macos-arm64.dmg dmg_x64=Point-Hub-$v-macos-x64.dmg

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
date=$(date -u +%F)
if [[ -n "${POINTHUB_RELEASE_DIR:-}" ]]; then
  files=$(cd "$POINTHUB_RELEASE_DIR" && pwd -P)
  published=$(gh release view "$tag" --repo "$REPO" --json publishedAt -q .publishedAt 2>/dev/null || true)
  [[ -z "$published" ]] || date=${published%%T*}
  echo "using the files in $files, release date $date"
else
  command -v gh >/dev/null || die "gh not found (it checks the release)"
  info=$(gh release view "$tag" --repo "$REPO" --json isDraft,isPrerelease,publishedAt \
    -q '"\(.isDraft) \(.isPrerelease) \(.publishedAt)"') || die "no release $tag in $REPO"
  read -r draft pre published <<<"$info"
  [[ $draft == false && $pre == false ]] || die "$tag is a draft or a prerelease: publish it first"
  date=${published%%T*}
  files=$tmp
  for f in "$msi" "$deb" "$dmg_arm64" "$dmg_x64"; do
    echo "downloading $f" >&2
    curl -fsSL --retry 3 -o "$files/$f" "$base_url/$f" || die "cannot download $base_url/$f"
  done
  curl -fsSL --retry 3 -o "$files/LICENSE" "https://raw.githubusercontent.com/$REPO/$tag/LICENSE" ||
    die "cannot download the LICENSE of $tag"
fi
for f in "$msi" "$deb" "$dmg_arm64" "$dmg_x64" LICENSE; do [[ -f "$files/$f" ]] || die "missing $files/$f"; done
sum() { sha256sum "$files/$1" | cut -d' ' -f1; }

# --- what the files are -------------------------------------------------------
[[ "$(dpkg-deb -f "$files/$deb" Package)" == point-hub && "$(dpkg-deb -f "$files/$deb" Version)" == "$v" &&
   "$(dpkg-deb -f "$files/$deb" Architecture)" == amd64 ]] || die "$deb is not point-hub $v amd64"
listing=$(dpkg-deb -c "$files/$deb")
grep -Eq ' (\./)?opt/point-hub/bin/point-hub$' <<<"$listing" ||
  die "$deb: no /opt/point-hub/bin/point-hub (jpackage's launcher)"

msi_property() {
  if command -v msiinfo >/dev/null 2>&1; then
    msiinfo export "$1" Property
  else
    command -v docker >/dev/null 2>&1 || die "need msiinfo (apt install msitools) or docker to read $1"
    docker run --rm -v "$1:/m.msi:ro" debian:trixie-slim sh -c \
      'apt-get update -qq >/dev/null && apt-get install -y -qq msitools >/dev/null 2>&1 && msiinfo export /m.msi Property'
  fi | tr -d '\r'
}
props=$(msi_property "$files/$msi")
prop() { awk -F '\t' -v k="$1" '$1 == k { print $2; exit }' <<<"$props"; }
[[ "$(prop ProductVersion)" == "$v" ]] || die "$msi: ProductVersion '$(prop ProductVersion)', expected $v"
[[ "$(prop UpgradeCode)" == "$UPGRADE_CODE" ]] || die "$msi: UpgradeCode '$(prop UpgradeCode)', expected $UPGRADE_CODE"
[[ "$(prop ALLUSERS)" == 1 ]] || die "$msi: not a per-machine package (ALLUSERS '$(prop ALLUSERS)')"
product_code=$(prop ProductCode)
[[ $product_code =~ ^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$ ]] ||
  die "$msi: no ProductCode, got '$product_code'"

# The bundle the cask installs: <volume>/<Name>.app at the top of each image,
# the same in both. jpackage names it point-hub.app today.
app_name=
for d in "$dmg_arm64" "$dmg_x64"; do
  plist=$(7z l -slt -ba "$files/$d" 2>/dev/null | sed -n 's/^Path = //p' |
    grep -E '^[^/]+/[^/]+\.app/Contents/Info\.plist$' | sort -u) || true
  [[ -n "$plist" && "$plist" != *$'\n'* ]] || die "$d: expected one <Name>.app at its top, found: ${plist:-none}"
  info=$(7z e -so "$files/$d" "$plist" 2>/dev/null | python3 -c '
import plistlib, sys
p = plistlib.loads(sys.stdin.buffer.read())
print(sys.argv[1], p.get("CFBundleIdentifier", ""), p.get("CFBundleShortVersionString", ""), sep="|")' \
    "$(basename "$(dirname "$(dirname "$plist")")")") || die "$d: cannot read $plist"
  IFS='|' read -r name id ver <<<"$info"
  [[ $name == *.app && $id == "$APP_ID" && $ver == "$v" ]] ||
    die "$d: the bundle is '$info' (name, identifier, version), expected <Name>.app $APP_ID $v"
  [[ -z "$app_name" || "$app_name" == "$name" ]] || die "the two disk images hold different bundles: $app_name, $name"
  app_name=$name
done

sha_msi=$(sum "$msi") sha_deb=$(sum "$deb") sha_lic=$(sum LICENSE)
sha_arm64=$(sum "$dmg_arm64") sha_x64=$(sum "$dmg_x64")

# --- Scoop --------------------------------------------------------------------
python3 - "$root/bucket/point-hub.json" "$v" "$sha_msi" <<'PY'
import json, sys
path, version, sha = sys.argv[1:4]
m = json.load(open(path, encoding="utf-8"))
m["version"] = version
url = m["autoupdate"]["architecture"]["64bit"]["url"].replace("$version", version)
m["architecture"]["64bit"] = {"url": url, "hash": sha}
with open(path, "w", encoding="utf-8") as f:
    json.dump(m, f, indent=4, ensure_ascii=False)
    f.write("\n")
PY

# --- Homebrew -----------------------------------------------------------------
python3 - "$root/Casks/point-hub.rb" "$v" "$sha_arm64" "$sha_x64" "$app_name" <<'PY'
import re, sys
path, version, arm, x64, app = sys.argv[1:6]
s = open(path, encoding="utf-8").read()
subs = [
    (r'(?m)^  version "[^"]*"$', f'  version "{version}"'),
    (r'(?m)^  sha256 arm:   "[0-9a-f]*",$', f'  sha256 arm:   "{arm}",'),
    (r'(?m)^         intel: "[0-9a-f]*"$', f'         intel: "{x64}"'),
    (r'(?m)^  app "[^"]*"$', f'  app "{app}"'),
    (r'(?m)^(      xattr -dr com\.apple\.quarantine "/Applications/)[^"]*"$', r'\g<1>' + app + '"'),
]
for pat, rep in subs:
    s, n = re.subn(pat, rep, s)
    if n != 1:
        sys.exit(f"bump: {path}: expected one line for {pat}, found {n}")
open(path, "w", encoding="utf-8").write(s)
PY

# --- winget -------------------------------------------------------------------
wbase=$here/winget/manifests/k/KSCWiedikon/PointHub
# only the version being submitted stays here (winget-pkgs keeps every version)
[[ ! -d "$wbase" ]] || find "$wbase" -mindepth 1 -maxdepth 1 -type d ! -name "$v" -exec rm -r {} +
out=$wbase/$v
mkdir -p "$out"
header() {
  printf '# yaml-language-server: $schema=https://aka.ms/winget-manifest.%s.%s.schema.json\n' "$1" "$MANIFEST_VERSION"
  printf '# Generated by packaging/bump.sh\n\n'
}
cat >"$out/$WINGET_ID.yaml" <<EOF
$(header version)

PackageIdentifier: $WINGET_ID
PackageVersion: $v
DefaultLocale: en-US
ManifestType: version
ManifestVersion: $MANIFEST_VERSION
EOF
# Scope machine (ALLUSERS=1, Program Files): winget runs a wix installer with
# its own switches and elevates a machine-scope MSI itself, so neither
# InstallerSwitches nor an ElevationRequirement.
cat >"$out/$WINGET_ID.installer.yaml" <<EOF
$(header installer)

PackageIdentifier: $WINGET_ID
PackageVersion: $v
InstallerType: wix
Scope: machine
UpgradeBehavior: install
ProductCode: '$product_code'
ReleaseDate: $date
AppsAndFeaturesEntries:
- DisplayName: point-hub
  Publisher: KSC Wiedikon
  DisplayVersion: $v
  ProductCode: '$product_code'
  UpgradeCode: '$UPGRADE_CODE'
InstallationMetadata:
  DefaultInstallLocation: '%ProgramFiles%\point-hub'
Installers:
- Architecture: x64
  InstallerUrl: $base_url/$msi
  InstallerSha256: $(tr 'a-f' 'A-F' <<<"$sha_msi")
ManifestType: installer
ManifestVersion: $MANIFEST_VERSION
EOF
cat >"$out/$WINGET_ID.locale.en-US.yaml" <<EOF
$(header defaultLocale)

PackageIdentifier: $WINGET_ID
PackageVersion: $v
PackageLocale: en-US
Publisher: KSC Wiedikon
PublisherUrl: https://kscw.ch
PublisherSupportUrl: https://github.com/$REPO/issues
Author: KSC Wiedikon
PackageName: 'Point Hub'
PackageUrl: https://github.com/$REPO
License: MIT
LicenseUrl: https://github.com/$REPO/blob/main/LICENSE
ShortDescription: 'The console of the LedBox scoreboard'
Description: 'Point Hub is the console of the LedBox scoreboard, for the scorer''s table. It finds the scoreboard on its own Wi-Fi or on the cable, also without internet, and shows the board''s console: the game on the board, the link to an OpenVolley eScoresheet match, the history and the settings.'
Moniker: point-hub
Tags:
- scoreboard
- volleyball
- ledbox
- sports
- console
ReleaseNotesUrl: https://github.com/$REPO/releases/tag/$tag
ManifestType: defaultLocale
ManifestVersion: $MANIFEST_VERSION
EOF

# --- AUR ----------------------------------------------------------------------
aur=$here/aur/point-hub-bin
sed -i \
  -e "s/^pkgver=.*/pkgver=$v/" \
  -e "s/^pkgrel=.*/pkgrel=$rel/" \
  -e "s/^sha256sums=.*/sha256sums=('$sha_lic')/" \
  -e "s/^sha256sums_x86_64=.*/sha256sums_x86_64=('$sha_deb')/" \
  "$aur/PKGBUILD"
if command -v makepkg >/dev/null 2>&1; then
  (cd "$aur" && makepkg --printsrcinfo) >"$tmp/SRCINFO"
else
  command -v docker >/dev/null 2>&1 || die "need makepkg or docker for .SRCINFO"
  docker run --rm -v "$aur/PKGBUILD:/in/PKGBUILD:ro" archlinux:latest bash -c '
    set -e
    mkdir /p && cp /in/PKGBUILD /p/ && chown -R nobody /p && cd /p
    runuser -u nobody -- makepkg --printsrcinfo' >"$tmp/SRCINFO"
fi
grep -q "pkgver = $v" "$tmp/SRCINFO" || { cat "$tmp/SRCINFO" >&2; die ".SRCINFO looks wrong"; }
cp "$tmp/SRCINFO" "$aur/.SRCINFO"

echo "Point Hub $v ($date):"
echo "  Scoop     bucket/point-hub.json   msi $sha_msi"
echo "  Homebrew  Casks/point-hub.rb      $app_name, arm64 $sha_arm64, x64 $sha_x64"
echo "  winget    ${out#"$root"/}/   ProductCode $product_code"
echo "  AUR       point-hub-bin $v-$rel  deb $sha_deb"
echo "next: packaging/check.sh --urls, commit, merge; then winget and the AUR (packaging/README.md)"
