#!/usr/bin/env bash
# Point Hub's own F-Droid repository, https://lucanepa.github.io/point-hub/fdroid/repo,
# served by GitHub Pages from this repository's gh-pages branch, with a small
# download page (index.html next to this script) at https://lucanepa.github.io/point-hub/.
#
#   packaging/fdroid/publish-fdroid.sh --init     once: create the repo and its key
#   packaging/fdroid/publish-fdroid.sh FILE.apk   add a release and publish
#   packaging/fdroid/publish-fdroid.sh            publish again (the page changed)
#
# FILE.apk is android/build-release.sh's android/dist/pointhub.apk. The repo is
# built in $FD; only its repo/ folder goes out. gh-pages holds one commit, the
# site as it is now, pushed with --force: no APK piles up in git history. The
# repo key ($FD/keystore.p12 + config.yml) never leaves $FD: back it up in the
# club's Vaultwarden, "Point Hub F-Droid repo key". Losing it means re-adding
# the repo under a new fingerprint (the app keeps updating: its key is another one).
#
# F-Droid only offers an update when versionCode grows (android/version.properties).
set -euo pipefail
umask 022
here=$(cd "$(dirname "$0")" && pwd -P)
root=$(cd "$here/../.." && pwd -P)
FD=${POINTHUB_FDROID_HOME:-$HOME/.config/point-hub-fdroid}
GH_REPO=${POINTHUB_PAGES_REPO:-Lucanepa/point-hub}
SITE_URL=https://lucanepa.github.io/point-hub
REPO_URL=$SITE_URL/fdroid/repo
APP_ID=ch.kscw.pointhub
REPO_ICON=point-hub-repo.png
die() { echo "publish-fdroid: $*" >&2; exit 1; }

INIT=0 APK='' NO_PUSH=${POINTHUB_FDROID_NO_PUSH:-0}
for a in "$@"; do
  case "$a" in
    --init) INIT=1 ;;
    -*) die "unknown option $a" ;;
    *) [[ -z "$APK" ]] || die "one APK at a time"; APK=$a ;;
  esac
done
for t in fdroid python3 keytool git curl; do command -v "$t" >/dev/null || die "$t not found"; done
SDK=${ANDROID_HOME:-$HOME/Android/Sdk}
bt=$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)
[[ -x "$bt/apksigner" && -x "$bt/aapt2" ]] || die "no Android build-tools (set ANDROID_HOME)"
# SHA-256 of the app's signing certificate (android/build-release.sh's key).
# Android refuses an update signed with another key: a different one is a hard stop.
APP_CERT_SHA256=$(tr -d ' \n' <"$root/android/signing-cert.sha256")
[[ $APP_CERT_SHA256 =~ ^[0-9a-f]{64}$ ]] || die "android/signing-cert.sha256: not a SHA-256"

fingerprint() {
  keytool -printcert -jarfile "$FD/repo/index-v1.jar" | sed -n 's/^[[:space:]]*SHA256: //p' | tr -d ':' | head -1
}

if (( INIT )); then
  [[ -z "$APK" ]] || die "--init takes no APK; publish one afterwards"
  [[ ! -e "$FD/config.yml" ]] || die "$FD/config.yml exists: the repo is already set up"
  install -d -m 700 "$FD"
  # fdroid init makes keystore.p12 and writes its passwords into config.yml.
  (cd "$FD" && fdroid init -q --android-home "$SDK" --repo-keyalias point-hub-fdroid)
  cat >>"$FD/config.yml" <<EOF
repo_url: $REPO_URL
repo_name: Point Hub
repo_description: >-
  Point Hub, the console of KSC Wiedikon's LedBox scoreboard, for the tablet
  at the scorer's table. Source: https://github.com/Lucanepa/point-hub
repo_icon: $REPO_ICON
EOF
  chmod 600 "$FD/config.yml" "$FD/keystore.p12"
  echo "created the repo in $FD"
  echo "back up $FD/config.yml and $FD/keystore.p12 (\"Point Hub F-Droid repo key\"),"
  echo "then publish an APK: $0 FILE.apk"
  exit 0
fi

[[ -f "$FD/config.yml" && -f "$FD/keystore.p12" ]] || die "no F-Droid repo in $FD (run $0 --init once, or restore it from the backup)"

if [[ -n "$APK" ]]; then
  [[ -f "$APK" ]] || die "no such file: $APK"
  certs=$("$bt/apksigner" verify --print-certs "$APK") || die "$APK: not a validly signed APK"
  grep -q "SHA-256 digest: $APP_CERT_SHA256" <<<"$certs" || die "$APK: not signed with Point Hub's app key"
  badging=$("$bt/aapt2" dump badging "$APK" | sed -n '/^package:/p')
  app_id=$(sed -E "s/^package: name='([^']+)'.*/\1/" <<<"$badging")
  code=$(sed -E "s/.*versionCode='([0-9]+)'.*/\1/" <<<"$badging")
  [[ "$app_id" == "$APP_ID" ]] || die "$APK: package $app_id, expected $APP_ID"
  install -d "$FD/repo"
  target="$FD/repo/${APP_ID}_${code}.apk"
  if [[ -e "$target" ]] && ! cmp -s "$APK" "$target"; then
    die "$target exists with different content; raise the version instead"
  fi
  install -m 644 "$APK" "$target"
  echo "added $target"
fi
ls "$FD/repo/${APP_ID}_"*.apk >/dev/null 2>&1 || die "the repo has no APK yet: $0 FILE.apk"

# The listing (name, summary, description, icon) and the repo's icon, kept in this repo.
icon="$root/android/desktop/icons/point-hub.png"
install -d "$FD/metadata/$APP_ID/en-US"
install -m 644 "$here/$APP_ID.yml" "$FD/metadata/$APP_ID.yml"
install -m 644 "$icon" "$FD/metadata/$APP_ID/en-US/icon.png"
install -m 644 "$icon" "$FD/$REPO_ICON"

(cd "$FD" && fdroid update -q)

leak=$(find "$FD/repo" \( -iname '*.p12' -o -iname '*.jks' -o -iname '*.keystore' -o -iname 'config.yml' \
  -o -iname '*passphrase*' \) -print)
[[ -z "$leak" ]] || die "refusing to publish, key material in the repo tree: $leak"

# The newest version, for the page.
read -r latest_code latest_name < <(python3 - "$FD/repo/index-v2.json" "$APP_ID" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
vs = [v["manifest"] for v in d["packages"][sys.argv[2]]["versions"].values()]
m = max(vs, key=lambda m: m["versionCode"])
print(m["versionCode"], m["versionName"])
PY
)
fp=$(fingerprint)
[[ $fp =~ ^[0-9A-F]{64}$ ]] || die "cannot read the repo's fingerprint from $FD/repo/index-v1.jar"

site=$(mktemp -d)
trap 'rm -rf "$site"' EXIT
install -d "$site/fdroid/repo"
# status/ is fdroidserver's run log (host OS, tool paths); clients never read it.
(cd "$FD/repo" && find . -path ./status -prune -o -type f -print0 | cpio -0pdm --quiet "$site/fdroid/repo")
sed -e "s|@REPO_URL@|$REPO_URL|g" -e "s|@FINGERPRINT@|$fp|g" -e "s|@APK@|fdroid/repo/${APP_ID}_${latest_code}.apk|g" \
  -e "s|@APK_VERSION@|$latest_name|g" "$here/index.html" >"$site/index.html"
! grep -q '@[A-Z_]*@' "$site/index.html" || die "index.html: a placeholder is left"
touch "$site/.nojekyll"

python3 - "$FD/repo/index-v2.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for app, p in d["packages"].items():
    for v in p["versions"].values():
        m = v["manifest"]
        print(f"  fdroid  {app} {m['versionName']} ({m['versionCode']})")
PY

if (( NO_PUSH )); then
  rm -rf "${POINTHUB_FDROID_SITE_OUT:?POINTHUB_FDROID_NO_PUSH needs POINTHUB_FDROID_SITE_OUT}"
  cp -a "$site" "$POINTHUB_FDROID_SITE_OUT"
  echo "not pushed: the site is in $POINTHUB_FDROID_SITE_OUT"
  exit 0
fi

git -C "$site" init -q -b gh-pages
git -C "$site" add -A
git -C "$site" commit -q -m "Point Hub F-Droid repo: $latest_name ($latest_code)"
git -C "$site" push -q --force "https://github.com/$GH_REPO.git" HEAD:refs/heads/gh-pages
echo "pushed to $GH_REPO gh-pages"
echo "add in F-Droid: $REPO_URL?fingerprint=$fp"

# GitHub Pages deploys it within a minute or two: only a warning here.
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if served=$(curl -fsS --max-time 15 "$REPO_URL/index-v2.json?t=$(date +%s)" 2>/dev/null) &&
     grep -q "${APP_ID}_${latest_code}.apk" <<<"$served"; then
    echo "live at $REPO_URL"
    exit 0
  fi
  sleep 15
done
echo "warning: $REPO_URL does not list ${APP_ID}_${latest_code}.apk yet (Pages still deploying? Settings > Pages)" >&2
