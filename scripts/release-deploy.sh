#!/usr/bin/env bash
# MIGA release deploy: push, tag, GitHub release, VDS (relay + web), live checks, AUR.
# Usage: scripts/release-deploy.sh [--dry-run] [--only stage,stage] VERSION
# Run it by hand (or by the conductor) AFTER scripts/release-build.sh. Never wired to hooks or timers.
# Stages: push tag release vds-backup vds-pull vds-relay vds-restart vds-web verify aur
# --dry-run prints what each stage would run and executes nothing (no ssh, no network writes).
set -euo pipefail

DRY=0; ONLY=""; V=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --only) ONLY=",${2:?--only needs a comma list},"; shift ;;
    -h|--help) sed -n 2,7p "$0"; exit 0 ;;
    -*) echo "unknown flag $1"; exit 2 ;;
    *) V="$1" ;;
  esac; shift
done
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "usage: $0 [--dry-run] [--only a,b] VERSION"; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${MIGA_OUT_ROOT:-$HOME/Projects}/MIGA-release-$V"
AUR="${MIGA_AUR_DIR:-$HOME/Projects/aur-miga-messenger}"
HOST="root@100.99.84.76"
RROOT="/root/Projects/MIGA"
# MIGA_LAYOUT=hardened (after the migration in docs/OPS.md): relay binary in /opt/miga run by the
# systemd unit as user "miga", web build in /srv/miga/web. Default "legacy" = PM2 as root, unchanged.
LAYOUT="${MIGA_LAYOUT:-legacy}"
[[ "$LAYOUT" == legacy || "$LAYOUT" == hardened ]] || { echo "MIGA_LAYOUT must be legacy or hardened"; exit 2; }
SITE="https://miga.vniverse77.com"
REPO="Vniverse77/MIGA"
LOG="$OUT/deploy.log"
[[ $DRY -eq 1 ]] || { mkdir -p "$OUT"; echo "=== deploy v$V $(date -Is)" >>"$LOG"; }

# run: execute (or only print in dry-run) one command; output goes to the log
run() {
  if [[ $DRY -eq 1 ]]; then printf '    would run: %s\n' "$*"; return 0; fi
  { echo "+ $*"; "$@"; } >>"$LOG" 2>&1
}
# sh_on_vds: one separate ssh call
vds() { run ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$1"; }
logmsg() { [[ $DRY -eq 1 ]] || echo "$*" >>"$LOG"; }

stage() { # stage name function
  local name="$1" fn="$2" rc=0
  [[ -z "$ONLY" || "$ONLY" == *",$name,"* ]] || return 0
  printf '%-14s' "$name"
  if [[ $DRY -eq 1 ]]; then echo "(dry-run)"; "$fn"; return 0; fi
  { echo; echo "=== $(date +%T) $name"; } >>"$LOG"
  ( set -euo pipefail; "$fn" ) || rc=$?
  if [[ $rc -eq 0 ]]; then echo OK; else echo "FAIL (exit $rc)  log: $LOG"; exit 1; fi
}
http() { curl -sS -m 20 "$@"; }

s_push() {
  if [[ $DRY -eq 0 ]]; then
    [[ "$(git -C "$ROOT" branch --show-current)" == master ]] || { logmsg "not on master"; return 1; }
    [[ "$(git -C "$ROOT" log -1 --format=%s)" == "Release v$V" ]] || { logmsg "HEAD is not 'Release v$V'"; return 1; }
    [[ -z "$(git -C "$ROOT" status --porcelain)" ]] || { logmsg "working tree not clean"; return 1; }
    for f in sha256sums.txt "MIGA_${V}_amd64.deb"; do [[ -f "$OUT/$f" ]] || { logmsg "missing $OUT/$f (run release-build.sh)"; return 1; }; done
  fi
  run git -C "$ROOT" push origin master
}
s_tag() {
  if [[ $DRY -eq 0 ]] && git -C "$ROOT" rev-parse -q --verify "refs/tags/v$V" >/dev/null; then
    logmsg "tag v$V exists locally"
  else run git -C "$ROOT" tag "v$V"; fi
  run git -C "$ROOT" push origin "v$V"
}
s_release() {
  local args=(release create "v$V" -R "$REPO" --title "MIGA $V")
  if [[ "$V" == *-* ]]; then args+=(--prerelease); else args+=(--latest); fi
  if [[ -f "$OUT/NOTES.md" || $DRY -eq 1 ]]; then args+=(--notes-file "$OUT/NOTES.md"); else args+=(--generate-notes); fi
  local f files=()
  if [[ $DRY -eq 1 ]]; then
    files=("$OUT/MIGA_${V}_amd64.deb" "$OUT/MIGA_${V}_x86_64.flatpak" "$OUT/MIGA_${V}-beta_android.apk" "$OUT/sha256sums.txt")
  else
    for f in "$OUT"/MIGA_* "$OUT/sha256sums.txt"; do [[ -f "$f" ]] && files+=("$f"); done
    [[ ${#files[@]} -gt 1 ]] || { logmsg "no artifacts in $OUT"; return 1; }
  fi
  run gh "${args[@]}" "${files[@]}"
}

relay_bin() { [[ "$LAYOUT" == hardened ]] && echo /opt/miga/miga-relay || echo "$RROOT/relay/miga-relay"; }
web_dir()   { [[ "$LAYOUT" == hardened ]] && echo /srv/miga/web || echo "$RROOT/web/build"; }

OLD=""
old_version() {
  [[ -n "$OLD" ]] && return 0
  if [[ $DRY -eq 1 ]]; then OLD="<live-version>"; return 0; fi
  OLD="$(http "$SITE/version.json" | jq -r .version)"
  [[ -n "$OLD" && "$OLD" != null ]] || { logmsg "cannot read live version"; return 1; }
  logmsg "live version before deploy: $OLD"
}
s_vds-backup() {
  old_version
  # never overwrite an older backup: add a timestamp if the name exists
  vds "set -e; s=\$(date +%H%M%S); \
r=/root/Projects/miga-relay.bak-$OLD; [ -e \$r ] && r=\$r-\$s; cp -a $(relay_bin) \$r; \
w=/root/Projects/MIGA-web-build.bak-$OLD; [ -e \$w ] && w=\$w-\$s; cp -a $(web_dir) \$w; ls -d \$r \$w"
}
s_vds-pull()    { vds "cd $RROOT && git pull --ff-only && git log -1 --oneline"; }
s_vds-relay() {
  vds "cd $RROOT/relay && CGO_ENABLED=0 go build -p 1 -o miga-relay && ls -l miga-relay"
  [[ "$LAYOUT" == hardened ]] && vds "install -o root -g root -m 0755 $RROOT/relay/miga-relay /opt/miga/miga-relay.new && mv /opt/miga/miga-relay.new /opt/miga/miga-relay" || true
}
s_vds-restart() {
  if [[ "$LAYOUT" == hardened ]]; then vds "systemctl restart miga-relay && systemctl is-active miga-relay"
  else vds "pm2 restart miga"; vds "pm2 save"; fi
}
s_vds-web() {
  [[ $DRY -eq 1 || -f "$ROOT/web/build/version.json" ]] || { logmsg "web/build missing"; return 1; }
  if [[ $DRY -eq 0 ]]; then
    local bv; bv="$(jq -r .version "$ROOT/web/build/version.json")"
    [[ "$bv" == "$V" ]] || { logmsg "local web/build is $bv, expected $V"; return 1; }
  fi
  if [[ "$LAYOUT" == hardened ]]; then
    run rsync -az --chown=root:root "$ROOT/web/build/" "$HOST:/srv/miga/web/"   # NO --delete; read-only for user miga
  else
    run rsync -az "$ROOT/web/build/" "$HOST:$RROOT/web/build/"      # NO --delete
  fi
}
s_verify() {
  if [[ $DRY -eq 1 ]]; then
    printf '    would check: %s/version.json == %s ; /app/ 200 ; OPTIONS /blob (Origin http://tauri.localhost) 204 ; /ws upgrade 101\n' "$SITE" "$V"
    return 0
  fi
  local got code bad=0
  sleep 3
  got="$(http "$SITE/version.json" | jq -r .version)"; echo "version.json: $got" >>"$LOG"
  [[ "$got" == "$V" ]] || { echo "FAIL version.json says $got, want $V" | tee -a "$LOG" >&2; bad=1; }
  code="$(http -o /dev/null -w '%{http_code}' "$SITE/app/")"; echo "/app/: $code" >>"$LOG"
  [[ "$code" == 200 ]] || { echo "FAIL /app/ -> $code" | tee -a "$LOG" >&2; bad=1; }
  code="$(http -o /dev/null -w '%{http_code}' -X OPTIONS -H 'Origin: http://tauri.localhost' \
        -H 'Access-Control-Request-Method: PUT' "$SITE/blob")"; echo "OPTIONS /blob: $code" >>"$LOG"
  [[ "$code" == 204 ]] || { echo "FAIL OPTIONS /blob -> $code (want 204)" | tee -a "$LOG" >&2; bad=1; }
  code="$(curl -s -m 5 --http1.1 -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
        -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
        -H 'Origin: http://tauri.localhost' "$SITE/ws" || true)"; echo "/ws: $code" >>"$LOG"
  [[ "$code" == 101 ]] || { echo "FAIL /ws -> $code (want 101)" | tee -a "$LOG" >&2; bad=1; }
  return $bad
}
s_aur() {
  if [[ "$V" == *-* ]]; then logmsg "pre-release: AUR skipped"; echo "    (pre-release, skipped)"; return 0; fi
  if [[ $DRY -eq 0 ]]; then
    [[ -f "$OUT/aur/PKGBUILD" && -f "$OUT/aur/.SRCINFO" ]] || { logmsg "missing $OUT/aur (run release-build.sh)"; return 1; }
    git ls-remote --exit-code --tags "https://github.com/$REPO.git" "refs/tags/v$V" >/dev/null || { logmsg "tag v$V not on GitHub"; return 1; }
  fi
  run cp "$OUT/aur/PKGBUILD" "$OUT/aur/.SRCINFO" "$AUR/"
  run git -C "$AUR" add PKGBUILD .SRCINFO
  run git -C "$AUR" commit -m "miga-messenger $V-1"
  run git -C "$AUR" push origin master
}

echo "MIGA deploy v$V$([[ $DRY -eq 1 ]] && echo ' [DRY RUN]')  (log: $LOG)"
stage push        s_push
stage tag         s_tag
stage release     s_release
stage vds-backup  s_vds-backup
stage vds-pull    s_vds-pull
stage vds-relay   s_vds-relay
stage vds-restart s_vds-restart
stage vds-web     s_vds-web
stage verify      s_verify
stage aur         s_aur
echo "done"
