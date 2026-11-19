#!/usr/bin/env bash
# Run once after `npx tauri android init --ci` (gen/android is git-ignored and regenerated):
# copies the hand-written MainActivity (insets, keyboard, status bar colours) into the generated project.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="$here/../src-tauri/gen/android/app/src/main/java/com/vniverse77/miga"
cp "$here/MainActivity.kt" "$dest/MainActivity.kt"
echo "patched $dest/MainActivity.kt"
# Opt in to predictive back: at the list (no page layer open) the system plays its back-to-home preview.
manifest="$here/../src-tauri/gen/android/app/src/main/AndroidManifest.xml"
if ! grep -q enableOnBackInvokedCallback "$manifest"; then
  sed -i '0,/<application/s//<application android:enableOnBackInvokedCallback="true"/' "$manifest"
fi
echo "patched $manifest"
