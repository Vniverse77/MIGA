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
# Camera for the QR scanner: wry's WebChromeClient asks for the runtime permission, but only if the manifest declares it.
if ! grep -q android.permission.CAMERA "$manifest"; then
  sed -i '0,/<uses-permission/s//<uses-permission android:name="android.permission.CAMERA" \/>\n    <uses-feature android:name="android.hardware.camera" android:required="false" \/>\n    <uses-permission/' "$manifest"
fi
echo "patched $manifest"
# Launcher icon: adaptive icon (background + foreground + monochrome for themed icons) and legacy PNG fallbacks.
resdir="$here/../src-tauri/gen/android/app/src/main/res"
cp -r "$here/res/." "$resdir/"
# the generated webp/png launcher icons would shadow ours; drop leftovers
find "$resdir" -name 'ic_launcher*.webp' -delete
rm -f "$resdir/drawable/ic_launcher_background.xml" "$resdir/drawable-v24/ic_launcher_foreground.xml"
echo "patched $resdir (launcher icons)"
