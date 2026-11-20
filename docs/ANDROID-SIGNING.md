# Android release signing

## Why
Android only installs an update if it is signed with the same key as the installed app. Until now the APK was
signed with the build machine's auto-generated debug key: it is not under the owner's control, not backed up on
purpose, and anyone with that machine's file could sign a fake "update". A real release key, created and kept by
the owner, fixes that. It must never be replaced afterwards.

## Create the key (owner, once, own terminal)
```
scripts/android-keygen.sh
```
- RSA 4096, PKCS12, validity 100 years, alias `miga`, DN `CN=MIGA, O=Vniverse77` (no personal data).
  RSA was chosen over EC P-256: apksigner supports both, but RSA works on every Android version and every tool.
- File: `~/.config/miga-release/miga-release.p12` (dir 0700, file 0600). The script refuses to write into
  `~/Projects`, `~/Documents`, Syncthing folders or other cloud folders, and refuses to overwrite an existing key.
- `keytool` asks for the password itself (no echo). Nobody else, and no tool, ever sees it.
- At the end it prints the certificate SHA-256 fingerprint. Publish it (README, landing page, release notes).

## Backups (do this immediately)
Two offline copies of the `.p12` AND the password (password manager): e.g. encrypted USB stick + a second
encrypted medium kept elsewhere. Never in the repo, Syncthing, or any cloud folder.

## Sign a release
`scripts/release-build.sh X.Y.Z` signs automatically:
- keystore: `MIGA_ANDROID_KEYSTORE` (default `~/.config/miga-release/miga-release.p12`), alias `MIGA_ANDROID_KEY_ALIAS` (default `miga`).
- password: asked once at start in the terminal (hidden), or taken from `MIGA_ANDROID_KS_PASS` if already set.
  It is passed to apksigner as `env:` only: never on a command line, never in `build.log`.
- if the keystore is missing the build FAILS. `MIGA_ALLOW_DEBUG_SIGNING=1` allows the old debug key (testing only;
  such an APK cannot update release-key installs).
- after signing, the certificate SHA-256 is printed and appended to `NOTES.md` (`android-signing-cert.txt` in the release folder).
  Compare it with the published fingerprint before publishing.
- Signature schemes v2/v3 are apksigner defaults (min SDK 24).

## If the key is lost
Installed apps can never be updated again: users must uninstall and reinstall a new app (new key), losing local
data. Treat the key like a root secret. If it leaks: same consequence plus a trust problem; publish a notice and migrate.

## Migration of existing users (one time)
Current installs (up to v0.8.x) are debug-signed. Android refuses to update them with a release-key APK, so each user
must **uninstall the old app and install the new one once**. Uninstalling deletes app data, including the
**identity key**, so users must first make a backup with the key-backup feature (P0-2, branch `feat/key-backup`) and restore it after
installing.

Recommendation: ship the key switch in the same release as the backup feature, or right after it, never before.
The previous release (backup feature present, debug-signed) lets users back up; the first release-key release
then needs the one-time reinstall. In that case: release N = backup feature (debug-signed, notice "back up now"),
release N+1 = key switch. If both ship together, the notice must say "back up first" prominently and the in-app
backup must work before uninstall. Also keep the old debug-signed APK downloadable for a while.
Do not skip the notice: silent failure ("app not installed, conflicting package") is what users will otherwise see.

### User notice (EN)
> One-time reinstall for Android. We are switching MIGA to a proper release signing key. Android will not
> update over the old version, so: 1) open MIGA, Settings, back up your key (and save the file somewhere safe),
> 2) uninstall MIGA, 3) install the new APK, 4) restore your backup. Without a backup your identity cannot be
> recovered. After this, updates install normally. Verify the APK: signing certificate SHA-256 is `<FINGERPRINT>`.

### User notice (TR)
> Android icin tek seferlik yeniden kurulum. MIGA'yi gercek bir surum imza anahtarina geciriyoruz. Android eski
> surumun uzerine guncellemeye izin vermez, bu yuzden: 1) MIGA'yi ac, Ayarlar, anahtarini yedekle (dosyayi guvenli
> bir yere kaydet), 2) MIGA'yi kaldir, 3) yeni APK'yi kur, 4) yedegini geri yukle. Yedek olmadan kimligin geri
> getirilemez. Bundan sonra guncellemeler normal kurulur. APK'yi dogrula: imza sertifikasi SHA-256 `<FINGERPRINT>`.

## Publishing the fingerprint
After key creation put the fingerprint in: README (section below), the landing page next to the APK link, and every
release's notes. Users verify with `apksigner verify --print-certs MIGA_X.Y.Z-beta_android.apk`.
