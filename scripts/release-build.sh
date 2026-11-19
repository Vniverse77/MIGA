#!/usr/bin/env bash
# MIGA release build: bump version, check, commit, build every artifact, collect into ~/Projects/MIGA-release-X.Y.Z/.
# Usage: scripts/release-build.sh VERSION [NOTES_FILE]      (run by a human/conductor only; no hooks)
# Does not push, tag, publish or deploy (that is scripts/release-deploy.sh). No sudo.
# Env: MIGA_RELEASE_BRANCH (default master), MIGA_OUT_ROOT (default ~/Projects), MIGA_SKIP="android flatpak aur deb"
#      (space-separated steps to skip; web, relay and check always run).
set -euo pipefail

V="${1:-}"; NOTES="${2:-}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "usage: $0 VERSION [NOTES_FILE]  (e.g. 0.8.0)"; exit 2; }
[[ -z "$NOTES" || -f "$NOTES" ]] || { echo "notes file not found: $NOTES"; exit 2; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${MIGA_RELEASE_BRANCH:-master}"
OUT="${MIGA_OUT_ROOT:-$HOME/Projects}/MIGA-release-$V"
LOG="$OUT/build.log"
SKIP=" ${MIGA_SKIP:-} "
BASE="${V%%-*}"                                   # Android/Tauri reject pre-release suffixes
IFS=. read -r MAJ MIN PAT <<<"$BASE"
VCODE=$((MAJ * 10000 + MIN * 100 + PAT))          # 0.7.0 -> 700, 0.8.0 -> 800
mkdir -p "$OUT"; : >"$LOG"
export ROOT V OUT LOG BASE VCODE

step() { # step "name" timeout_seconds function
  local name="$1" t="$2" fn="$3" rc=0
  printf '%-34s' "$name"
  { echo; echo "=== $(date +%T) $name"; } >>"$LOG"
  timeout "$t" bash -c "set -euo pipefail; $fn" >>"$LOG" 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then echo OK; else
    [[ $rc -eq 124 ]] && echo "FAIL (timeout ${t}s)" || echo "FAIL (exit $rc)"
    echo "log: $LOG"; exit 1
  fi
}
skipped() { [[ "$SKIP" == *" $1 "* ]]; }

f_preflight() {
  cd "$ROOT"
  [[ "$(git branch --show-current)" == "$BRANCH" ]] || { echo "not on $BRANCH"; exit 1; }
  [[ -z "$(git status --porcelain)" ]] || { git status --short; echo "working tree not clean"; exit 1; }
  for c in jq deno npm cargo go git perl; do command -v $c >/dev/null || { echo "missing: $c"; exit 1; }; done
}

f_bump() {
  cd "$ROOT"
  # first "version" line of each JSON file (tab-indented, formatting untouched)
  for f in web/package.json desktop/package.json desktop/src-tauri/tauri.conf.json; do
    perl -0pi -e 's/("version":\s*")[^"]*(")/${1}$ENV{V}$2/' "$f"
  done
  # desktop lock: root + packages[""] (first two "version" entries)
  perl -0pi -e 'my $n=0; s/("version":\s*")[^"]*(")/++$n<=2 ? "${1}$ENV{V}$2" : $&/ge' desktop/package-lock.json
  # Android config: versionName without pre-release suffix, versionCode derived
  perl -0pi -e 's/("version":\s*")[^"]*(")/${1}$ENV{BASE}$2/; s/("versionCode":\s*)\d+/${1}$ENV{VCODE}/' desktop/src-tauri/tauri.android.conf.json
  # Cargo.toml: version of [package]; Cargo.lock: the "miga" package block
  perl -0pi -e 's/^(version\s*=\s*")[^"]*(")/${1}$ENV{V}$2/m' desktop/src-tauri/Cargo.toml
  perl -0pi -e 's/(name = "miga"\nversion = ")[^"]*(")/${1}$ENV{V}$2/' desktop/src-tauri/Cargo.lock
  # AUR: pkgver cannot contain "-"; pre-releases are not published to the AUR
  perl -pi -e 's/^pkgver=.*/pkgver=$ENV{V}/; s/^pkgrel=.*/pkgrel=1/' packaging/aur/PKGBUILD
  # Flatpak manifest (.deb name), landing download names, docs examples
  perl -pi -e 's/MIGA_[^_\/]+_amd64\.deb/MIGA_$ENV{V}_amd64.deb/' packaging/flatpak/com.vniverse77.miga.yml
  perl -pi -e 's/MIGA_[^_\x27]+_x86_64\.flatpak/MIGA_$ENV{V}_x86_64.flatpak/; s{download/v[^\/]+/}{download/v$ENV{V}/}; s/MIGA_[^_\x27]+-beta_android\.apk/MIGA_$ENV{V}-beta_android.apk/' web/src/lib/site/Landing.svelte
  perl -pi -e 's/MIGA_[^_ ]+-beta_android\.apk/MIGA_$ENV{V}-beta_android.apk/g; s/(sets the version to `)[^`]*(`)/${1}$ENV{BASE}$2/; s/(`versionCode` )\d+/${1}$ENV{VCODE}/' docs/BUILDING.md
  git diff --stat | tail -1
}

f_check() { cd "$ROOT/web"; [[ -d node_modules ]] || npm install --no-audit --no-fund --no-package-lock; deno task check; }

f_commit() {
  cd "$ROOT"
  if [[ -z "$(git status --porcelain)" ]]; then echo "nothing to commit (already at $V)"; return; fi
  git add -u
  git commit -q -m "Release v$V"
  git log -1 --oneline
}

f_web() { cd "$ROOT/web"; npm run build; grep -q "\"version\":\"$V\"\|\"version\": \"$V\"" build/version.json; cat build/version.json; }

f_relay() { cd "$ROOT/relay"; go vet ./...; CGO_ENABLED=0 go build -p 1 -o miga-relay; ls -l miga-relay; }

f_deb() {
  cd "$ROOT/web"; npm run build:desktop
  cd "$ROOT/desktop"; [[ -d node_modules ]] || npm install --no-audit --no-fund --no-package-lock
  npx tauri build --bundles deb
  cp "src-tauri/target/release/bundle/deb/MIGA_${V}_amd64.deb" "$OUT/"
}

f_flatpak() {
  command -v flatpak-builder >/dev/null
  local sm="$HOME/.cache/miga-flatpak/shared-modules"
  [[ -d "$sm" ]] || git clone --depth 1 https://github.com/flathub/shared-modules "$sm"
  # build dirs must be on the same filesystem as the state dir ($ROOT/.flatpak-builder), so not /tmp
  mkdir -p "$HOME/.cache/miga-flatpak"
  local t; t="$(mktemp -d "$HOME/.cache/miga-flatpak/build.XXXXXX")"
  cd "$ROOT"
  local rc=0
  flatpak-builder --user --force-clean --repo="$t/repo" "$t/build" packaging/flatpak/com.vniverse77.miga.yml \
    && flatpak build-bundle "$t/repo" "$OUT/MIGA_${V}_x86_64.flatpak" com.vniverse77.miga || rc=$?
  rm -rf "$t"
  return $rc
}

f_android() {
  # shellcheck disable=SC1091
  source "$HOME/.local/share/android-env.sh"
  command -v zipalign >/dev/null && command -v apksigner >/dev/null
  [[ -f "$HOME/.android/debug.keystore" ]]
  cd "$ROOT/web"; npm run build:mobile
  cd "$ROOT/desktop"; [[ -d node_modules ]] || npm install --no-audit --no-fund --no-package-lock
  [[ -d src-tauri/gen/android/app ]] || npx tauri android init --ci
  bash android-patch/apply.sh
  npx tauri android build --apk --target aarch64 --target armv7
  local u="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
  local t; t="$(mktemp -d "${TMPDIR:-/tmp}/miga-apk.XXXXXX")"
  local rc=0
  { zipalign -f -p 4 "$u" "$t/aligned.apk" \
    && apksigner sign --ks "$HOME/.android/debug.keystore" --ks-pass pass:android --key-pass pass:android \
         --ks-key-alias androiddebugkey --out "$OUT/MIGA_${V}-beta_android.apk" "$t/aligned.apk" \
    && rm -f "$OUT/MIGA_${V}-beta_android.apk.idsig" \
    && apksigner verify --print-certs "$OUT/MIGA_${V}-beta_android.apk" | head -3; } || rc=$?
  rm -rf "$t"
  return $rc
}

f_aur() {
  [[ "$V" != *-* ]] || { echo "pre-release: AUR test skipped"; return; }
  command -v makepkg >/dev/null
  local t head; t="$(mktemp -d "${TMPDIR:-/tmp}/miga-aur.XXXXXX")"
  head="$(git -C "$ROOT" rev-parse HEAD)"
  mkdir -p "$OUT/aur"
  cp "$ROOT/packaging/aur/PKGBUILD" "$t/PKGBUILD"
  (cd "$t" && makepkg --printsrcinfo > "$OUT/aur/.SRCINFO")   # from the real PKGBUILD (tag source)
  cp "$ROOT/packaging/aur/PKGBUILD" "$OUT/aur/PKGBUILD"
  # test build against the local repo at the release commit (the tag does not exist yet)
  perl -pi -e "s{^source=.*}{source=(\"miga::git+file://$ROOT#commit=$head\")}" "$t/PKGBUILD"
  local rc=0
  (cd "$t" && makepkg -f --nodeps --skipinteg --noconfirm && ls -l ./*.pkg.tar.*) || rc=$?
  rm -rf "$t"
  return $rc
}

f_collect() {
  [[ -z "$NOTES" ]] || cp "$NOTES" "$OUT/NOTES.md"
  cd "$OUT"
  # shellcheck disable=SC2046
  sha256sum $(ls MIGA_* 2>/dev/null) > sha256sums.txt
  cat sha256sums.txt
  git -C "$ROOT" status --porcelain
}
export -f f_preflight f_bump f_check f_commit f_web f_relay f_deb f_flatpak f_android f_aur f_collect
export NOTES BRANCH SKIP

echo "MIGA release build v$V (log: $LOG)"
step "preflight (clean $BRANCH)"   120  f_preflight
step "bump version"                120  f_bump
step "deno task check"             900  f_check
step "commit Release v$V"          60   f_commit
step "web build"                   900  f_web
step "relay vet+build"             900  f_relay
skipped deb     || step "desktop .deb"          2400 f_deb
skipped flatpak || step "flatpak bundle"        2400 f_flatpak
skipped android || step "android APK"           3000 f_android
skipped aur     || step "AUR makepkg test"      1800 f_aur
step "collect + sha256"            60   f_collect

echo "--- summary"
echo "version : $V   commit: $(git -C "$ROOT" rev-parse --short HEAD)"
echo "folder  : $OUT"
(cd "$OUT" && ls -1 MIGA_* 2>/dev/null | sed 's/^/  /')
echo "next    : scripts/release-deploy.sh --dry-run $V   then without --dry-run"
