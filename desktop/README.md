# MIGA desktop

A thin [Tauri 2](https://tauri.app) shell around the same web interface that the relay serves.
The interface files are inside the package, so nothing is downloaded at start and a server cannot
swap the app's code. No native command is exposed to the page.

## Build

```sh
cd web && deno task build            # or: npm install && npm run build
cd ../desktop && npm install
npx tauri build --bundles deb        # binary + .deb in src-tauri/target/release/
```

Needs Rust (stable), Node, and the WebKitGTK 4.1 development files
(Arch: `webkit2gtk-4.1`; Debian/Ubuntu: `libwebkit2gtk-4.1-dev`).

## Relay

The packaged app is not served by a relay, so it connects to the public one
(`wss://miga.vniverse77.com/ws`). Its pages have the origin `tauri://localhost`; the relay must
list that origin in `MIGA_ORIGINS`, otherwise it refuses the connection and the app shows "offline".

## Packages

| Format | Where | State |
|---|---|---|
| .deb | built by `tauri build --bundles deb` | builds locally |
| AUR | `packaging/aur/PKGBUILD` (from source) | written, needs a `v0.2.1` tag and a licence |
| Flatpak | `packaging/flatpak/com.vniverse77.miga.yml` | draft, not built yet |
