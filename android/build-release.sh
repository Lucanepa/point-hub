#!/usr/bin/env bash
# Build a signed release of the Point Hub tablet app into android/dist/:
#   dist/pointhub.apk     the APK the board serves at /app/pointhub.apk
#   dist/version.json     {versionCode, versionName, sha256, url, notes, size} for /app/version.json
#
# Usage: ./build-release.sh [--notes "text"] [--version-name X.Y.Z] [--first]
#
# versionCode only ever goes up. Every build computes
#   new = max(VERSION_CODE, RELEASED_CODE, ~/.config/pointhub-android/last-version-code,
#             dist/version.json) + 1
# and writes it back as both VERSION_CODE and RELEASED_CODE in version.properties. RELEASED_CODE is
# TRACKED in git, so a fresh clone on another machine still continues above every earlier release:
# commit version.properties after each release.
#
# --first  the very first release: build VERSION_CODE as it is. Refused once RELEASED_CODE is set.
set -euo pipefail

NOTES=""
VNAME=""
FIRST=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --notes) NOTES="$2"; shift 2 ;;
    --version-name) VNAME="$2"; shift 2 ;;
    --first) FIRST=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")"
export ANDROID_HOME="${ANDROID_HOME:-/home/lucanepa/Android/Sdk}"
if [[ -z "${JAVA_HOME:-}" ]]; then
  JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
  export JAVA_HOME
fi
BT="$ANDROID_HOME/build-tools/35.0.0"
CONF="$HOME/.config/pointhub-android"
[[ -f local.properties ]] || echo "sdk.dir=$ANDROID_HOME" > local.properties

die() { echo "ERROR: $*" >&2; exit 1; }

# ---- 1. The signing properties must resolve, in the same order as app/build.gradle.kts ----
resolve_props() {
  local f
  for f in keystore.properties "${POINTHUB_KEYSTORE_PROPERTIES:-}" "$CONF/keystore.properties"; do
    [[ -n "$f" && -f "$f" ]] || continue
    local ind
    ind=$(grep -E '^propertiesFile=' "$f" | head -1 | cut -d= -f2- || true)
    if [[ -n "$ind" ]]; then [[ -f "$ind" ]] && { echo "$ind"; return; } || return 1; fi
    echo "$f"; return
  done
  return 1
}
PROPS=$(resolve_props) || die "no signing properties found (android/keystore.properties, \$POINTHUB_KEYSTORE_PROPERTIES or $CONF/keystore.properties). Refusing to build an unsigned release."
STORE=$(grep -E '^storeFile=' "$PROPS" | cut -d= -f2-)
[[ -f "$STORE" ]] || die "keystore $STORE (from $PROPS) does not exist"
EXPECTED_CERT=$(tr -d ' \n' < signing-cert.sha256)

# ---- 2. Version bump ----
prop() { { grep -E "^$1=" version.properties || true; } | head -1 | cut -d= -f2 | tr -dc '0-9A-Za-z._-'; }
cur_code=$(prop VERSION_CODE)
cur_name=$(prop VERSION_NAME)
released=$(prop RELEASED_CODE | tr -dc '0-9'); released=${released:-0}
[[ "$cur_code" =~ ^[0-9]+$ ]] || die "version.properties: bad VERSION_CODE '$cur_code'"
local_code=0
[[ -f "$CONF/last-version-code" ]] && local_code=$(tr -dc '0-9' < "$CONF/last-version-code")
local_code=${local_code:-0}
dist_code=0
if [[ -f dist/version.json ]]; then
  dist_code=$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1]))["versionCode"]))' dist/version.json 2>/dev/null || echo 0)
fi
if (( FIRST == 1 )); then
  (( released == 0 )) || die "--first: version.properties says versionCode $released was already released"
  if (( local_code > 0 || dist_code > 0 )); then
    echo "note: --first ignores this machine's earlier unpublished builds (last-version-code=$local_code, dist=$dist_code)" >&2
  fi
  new_code=$cur_code
  last=0
else
  last=$released
  (( local_code > last )) && last=$local_code
  (( dist_code > last )) && last=$dist_code
  if (( released == 0 && local_code == 0 && dist_code == 0 )); then
    die "no earlier release is recorded anywhere. For the very first release use --first; otherwise restore RELEASED_CODE in version.properties (see git history) or ~/.config/pointhub-android/last-version-code"
  fi
  new_code=$(( (cur_code > last ? cur_code : last) + 1 ))
fi
if [[ -n "$VNAME" ]]; then
  new_name=$VNAME
elif (( new_code != cur_code )); then
  # Bump the patch number along with the code (1.0.0 -> 1.0.1).
  new_name=$(python3 -c 'import sys; p=sys.argv[1].split("."); p[-1]=str(int(p[-1])+1) if p[-1].isdigit() else p[-1]+".1"; print(".".join(p))' "$cur_name")
else
  new_name=$cur_name
fi
[[ "$new_name" =~ ^[0-9A-Za-z._-]{1,40}$ ]] || die "bad version name: $new_name"
write_props() {  # VERSION_CODE VERSION_NAME RELEASED_CODE
  printf '# Written by build-release.sh. VERSION_CODE must only ever go up.\n# RELEASED_CODE: the highest versionCode ever built for release. Commit this file after a release.\nVERSION_CODE=%s\nVERSION_NAME=%s\nRELEASED_CODE=%s\n' "$1" "$2" "$3" > version.properties
}
# RELEASED_CODE moves only once the APK is built and verified (end of the script).
write_props "$new_code" "$new_name" "$released"
echo "==> Building Point Hub $new_name (versionCode $new_code; last released: $last)"

# ---- 3. Build, lint and test ----
./gradlew --no-daemon clean lintRelease testReleaseUnitTest assembleRelease

# ---- 4. Collect and verify ----
mkdir -p dist
cp app/build/outputs/apk/release/app-release.apk dist/pointhub.apk
APK=dist/pointhub.apk

"$BT/apksigner" verify --verbose --print-certs --min-sdk-version 26 "$APK" > dist/apksigner.txt 2>&1 \
  || { cat dist/apksigner.txt; die "apksigner verify failed"; }
cert=$(grep -m1 'Signer #1 certificate SHA-256 digest:' dist/apksigner.txt | awk '{print $NF}')
[[ "$cert" == "$EXPECTED_CERT" ]] || die "APK signed with $cert, expected $EXPECTED_CERT (signing-cert.sha256). Wrong key!"

badging=$("$BT/aapt2" dump badging "$APK")
grep -q "package: name='ch.kscw.pointhub' versionCode='$new_code' versionName='$new_name'" <<<"$badging" || die "badging: package/version mismatch"
grep -qE "^(min)?[sS]dkVersion:'26'" <<<"$badging" || die "badging: minSdk is not 26"
grep -q "targetSdkVersion:'35'" <<<"$badging" || die "badging: targetSdk is not 35"
grep -q "application-label:'Point Hub'" <<<"$badging" || die "badging: label is not 'Point Hub'"

# ---- 5. version.json ----
sha=$(sha256sum "$APK" | awk '{print $1}')
size=$(stat -c %s "$APK")
python3 - "$new_code" "$new_name" "$sha" "$size" "$NOTES" > dist/version.json <<'PY'
import json, sys
code, name, sha, size, notes = sys.argv[1:6]
json.dump({"versionCode": int(code), "versionName": name, "sha256": sha,
           "url": "/app/pointhub.apk", "notes": notes, "size": int(size)}, sys.stdout, indent=2)
print()
PY

write_props "$new_code" "$new_name" "$new_code"
mkdir -p "$CONF" && chmod 700 "$CONF"
echo "$new_code" > "$CONF/last-version-code"

echo
echo "==> OK: dist/pointhub.apk  (versionCode $new_code, versionName $new_name, $size bytes)"
echo "    sha256 $sha"
echo "    signer $cert"
cat dist/version.json
echo
echo "Next: copy dist/pointhub.apk and dist/version.json to the board's served /app/ directory."
echo "Commit android/version.properties (RELEASED_CODE=$new_code) so every clone continues above it."
