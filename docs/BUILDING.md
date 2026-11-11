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

## Desktop (Linux)
Needs: Rust stable (`rustup default stable`), Node with npm, WebKitGTK 4.1 development files
(Arch `webkit2gtk-4.1`, Debian/Ubuntu `libwebkit2gtk-4.1-dev`).

```sh
cd web && deno task build:desktop
cd ../desktop && npm install
npx tauri build --bundles deb     # binary: src-tauri/target/release/miga, package: .../bundle/deb/
```

The relay must list `tauri://localhost` in `MIGA_ORIGINS`, otherwise it answers 403 and the app shows "offline".

### .deb
`sudo apt install ./MIGA_<version>_amd64.deb` on Debian or Ubuntu.

### AUR (`packaging/aur/PKGBUILD`, builds from the git tag)
```sh
cd packaging/aur && makepkg -si           # local test build and install
namcap PKGBUILD *.pkg.tar.zst             # lint
# publish (needs an AUR account with your SSH public key):
git clone ssh://aur@aur.archlinux.org/miga.git aur-miga
cp PKGBUILD aur-miga/ && cd aur-miga
makepkg --printsrcinfo > .SRCINFO
git add PKGBUILD .SRCINFO && git commit -m "miga <version>" && git push
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

## Android (not started)
```sh
sudo pacman -S jdk17-openjdk
# Android SDK + NDK: Android Studio, or the command-line tools; then:
export ANDROID_HOME=$HOME/Android/Sdk NDK_HOME=$ANDROID_HOME/ndk/<version>
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
cd web && deno task build:mobile
cd ../desktop && npx tauri android init && npx tauri android build --apk
```
The relay will also need `http://tauri.localhost` in `MIGA_ORIGINS`.
