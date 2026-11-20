# Building MIGA

One code base, three targets. Each build contains only its own platform code
(`web/src/lib/platform/{web,desktop,mobile}.ts`, chosen at build time by `MIGA_TARGET`).

| Target | Command (in `web/`) | Output | Talks to |
|---|---|---|---|
| web | `deno task build` | `web/build` | the relay that serves the page |
| desktop | `deno task build:desktop` | `web/build-desktop` | the public relay |
| mobile | `deno task build:mobile` | `web/build-mobile` | the public relay |

`npm run <task>` works in place of `deno task <task>`. Every build writes `version.json`
(`target`, `version`, `commit`, `built`); the same data is shown next to the name in the app.

## Release checklist
1. Bump the version in `web/package.json`, `desktop/package.json`, `desktop/src-tauri/Cargo.toml`,
   `desktop/src-tauri/tauri.conf.json`, `packaging/aur/PKGBUILD` and the `.deb` name in the Flatpak manifest.
2. `deno task check`, build, `bash web/.dev/run-e2e.sh`.
3. Commit, then build again so `version.json` carries the new commit. Tag `v<version>`.
4. Web: copy `web/build/` to the relay's static folder; check `curl https://<host>/version.json`.

## Release scripts (one command each)
```sh
scripts/release-build.sh 0.8.0 [notes.md]    # bump everywhere, check, commit "Release v0.8.0", build all, collect
scripts/release-deploy.sh --dry-run 0.8.0    # print what the deploy would do
scripts/release-deploy.sh 0.8.0              # push, tag, GitHub release, VDS relay+web, live checks, AUR
```
`release-build.sh` needs a clean `master`; it writes `~/Projects/MIGA-release-<version>/` (`.deb`, `.flatpak`,
`-beta_android.apk`, `sha256sums.txt`, `NOTES.md`, `aur/`) and `build.log`; the console shows only step names and OK/FAIL.
`MIGA_SKIP="flatpak android aur"` skips steps. Android versionCode is `major*10000 + minor*100 + patch` (0.8.0 -> 800).
`release-deploy.sh` logs to `deploy.log` in the same folder, runs one stage at a time (`--only tag,release` to resume),
and fails loudly if a live check (version.json, `/app/` 200, `OPTIONS /blob` 204, `/ws` 101) does not pass. Run both by hand only.

## Desktop (Linux)
Needs: Rust stable (`rustup default stable`), Node with npm, WebKitGTK 4.1 development files
(Arch `webkit2gtk-4.1`, Debian/Ubuntu `libwebkit2gtk-4.1-dev`).

```sh
cd web && deno task build:desktop
cd ../desktop && npm install
npx tauri build --bundles deb     # binary: src-tauri/target/release/miga-messenger, package: .../bundle/deb/
```

The relay must list `tauri://localhost` in `MIGA_ORIGINS`, otherwise it answers 403 and the app shows "offline".

### .deb
`sudo apt install ./MIGA_<version>_amd64.deb` on Debian or Ubuntu.

### AUR (`packaging/aur/PKGBUILD`, builds from the git tag)
```sh
cd packaging/aur && makepkg -si           # local test build and install
namcap PKGBUILD *.pkg.tar.zst             # lint
# publish (needs an AUR account with your SSH public key):
git clone ssh://aur@aur.archlinux.org/miga-messenger.git aur-miga
cp PKGBUILD aur-miga/ && cd aur-miga
makepkg --printsrcinfo > .SRCINFO
git add PKGBUILD .SRCINFO && git commit -m "miga-messenger <version>" && git push
```
Before publishing: the tag `v<version>` must exist on GitHub and `license=` must name the real licence.

### Flatpak (`packaging/flatpak/com.vniverse77.miga.yml`)
```sh
sudo pacman -S flatpak-builder
flatpak install flathub org.gnome.Platform//51 org.gnome.Sdk//51
flatpak-builder --user --install --force-clean build-dir packaging/flatpak/com.vniverse77.miga.yml
flatpak run com.vniverse77.miga
```
The manifest repackages the `.deb`, which is fine for local use. Flathub wants more: a build from source
with vendored Cargo and npm sources, an AppStream `metainfo.xml` with screenshots, and a pull request to
`github.com/flathub/flathub` (branch `new-pr`). That is a separate step.

## Android (beta, sideload)
Needs JDK 17+ (Temurin 21 works), Android SDK (platform + build-tools 35, platform-tools) and NDK, user-space is fine:
```sh
export JAVA_HOME=<jdk> ANDROID_HOME=$HOME/Android/Sdk NDK_HOME=$ANDROID_HOME/ndk/<version>
rustup target add aarch64-linux-android armv7-linux-androideabi
cd web && npm run build:mobile                      # web/build-mobile
cd ../desktop && npm install && npx tauri android init --ci   # once; gen/android is git-ignored
bash android-patch/apply.sh                       # after every init: insets, keyboard and status bar colours
npx tauri android build --apk --target aarch64 --target armv7 # ONE universal APK
```
`desktop/src-tauri/tauri.android.conf.json` is merged over `tauri.conf.json` on Android: it points
`frontendDist` at `web/build-mobile`, sets the version to `0.9.0` (versionName; Tauri rejects pre-release
suffixes for Android) and `versionCode` 900. Tray and close-to-tray are `#[cfg(desktop)]` in `src/lib.rs`, and
the `tray-icon` feature sits in a non-Android target dependency in `Cargo.toml`.

Sign the unsigned APK (debug key for beta sideloading; use a real upload key for Play Store):
```sh
U=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
zipalign -f -p 4 $U aligned.apk
apksigner sign --ks ~/.android/debug.keystore --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey --out MIGA_0.9.0-beta_android.apk aligned.apk
apksigner verify --print-certs MIGA_0.9.0-beta_android.apk
```
(`keytool -genkeypair -keystore ~/.android/debug.keystore -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"` if the keystore is missing.)
The relay will also need `http://tauri.localhost` in `MIGA_ORIGINS`.
