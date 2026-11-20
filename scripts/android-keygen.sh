#!/usr/bin/env bash
# MIGA: create the Android RELEASE signing key. Run by the OWNER in his own terminal.
# keytool asks for the password itself (no echo); it never touches the command line, a log or an env var.
# Key: RSA 4096 (not EC P-256): apksigner supports both, but RSA is accepted by every Android version and
#      every tool/store; size is irrelevant for a signature. PKCS12, validity 100 years, alias "miga".
# Usage: scripts/android-keygen.sh        (env: MIGA_KEYSTORE_DIR to change the dir, default ~/.config/miga-release)
set -euo pipefail
# shellcheck disable=SC1091
source "$HOME/.local/share/android-env.sh" 2>/dev/null || true
command -v keytool >/dev/null || { echo "keytool not found (install a JDK / source android-env.sh)"; exit 1; }

DIR="${MIGA_KEYSTORE_DIR:-$HOME/.config/miga-release}"
KS="$DIR/miga-release.p12"
ALIAS="miga"

# refuse synced / cloud / repo locations
real="$(realpath -m "$DIR")"
blocked=("$HOME/Projects" "$HOME/Documents" "$HOME/Sync" "$HOME/Dropbox" "$HOME/Insync" "$HOME/Google Drive")
if [[ -f "$HOME/.config/syncthing/config.xml" ]]; then   # paths only, nothing else is read
  while IFS= read -r p; do p="${p/#\~/$HOME}"; [[ -n "$p" ]] && blocked+=("$p"); done \
    < <(grep -o '<folder [^>]*path="[^"]*"' "$HOME/.config/syncthing/config.xml" | sed 's/.*path="//; s/"$//')
fi
for b in "${blocked[@]}"; do
  b="$(realpath -m "$b")"
  if [[ "$real" == "$b" || "$real" == "$b"/* ]]; then
    echo "REFUSED: $real is inside a synced/cloud/repo folder ($b). Use the default ~/.config/miga-release."; exit 1
  fi
done

[[ ! -e "$KS" ]] || { echo "REFUSED: $KS already exists. Never overwrite a release key. Move it away yourself if you are sure."; exit 1; }
mkdir -p "$DIR"; chmod 700 "$DIR"

echo "Creating the MIGA release key at: $KS"
echo "keytool will ask for a password twice. Use a long unique one and store it in your password manager."
echo
umask 077
keytool -genkeypair -v -storetype PKCS12 -keystore "$KS" -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=MIGA, O=Vniverse77"
chmod 600 "$KS"

echo
echo "=== Certificate SHA-256 fingerprint (publish this; users verify against it) ==="
echo "(keytool asks for the password once more)"
keytool -list -v -storetype PKCS12 -keystore "$KS" -alias "$ALIAS" | grep -E 'SHA256:|Valid from'
cat <<MSG

NOW, before anything else, make 2 OFFLINE backups of:
  $KS
  + the password (in a password manager)
Examples: an encrypted USB stick, plus an encrypted copy in a second place.
NEVER put them in the repo, Syncthing, or any cloud folder. If the key or password is lost, installed
apps can never be updated again (see docs/ANDROID-SIGNING.md).
MSG
