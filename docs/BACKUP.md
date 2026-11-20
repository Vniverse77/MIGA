# Key backup

MIGA has no accounts and no server copy of anything. The account is a secret key kept on the device, so
losing the device (or erasing it) loses the address. A backup is the only way back. Everything here runs
on the device; **a backup is never uploaded** by MIGA, and the relay never sees it.

## Two kinds of backup

| Kind | What it holds | Form |
| --- | --- | --- |
| Backup file (`.miga`) | secret key; optionally contacts, profile, block/mute lists, settings and message history | file saved by the person |
| Recovery code | the secret key only (32 bytes) | QR code and a grouped text code (`ABCDE-FGHJK-...`) |

The own profile photo (256x256 image, base64 in `photo: { type, data }`) and the pins (`pins: { m, c }`: pinned messages per chat, pinned chats) are part of the profile choice and are optional fields, so v0.9.3 and older files still restore and the payload stays `v: 1`. Attachments are not included in a backup file (they are not stored in the page data). Restoring on a new
device brings back the same address; chats of contacts then resync as usual.

## Container format (version 1)

Both kinds use one container. All fields are single bytes unless noted.

```
offset  size  field
0       4     magic "MIGA" (4D 49 47 41)
4       1     format version (1)
5       1     kind: 1 = backup file, 2 = recovery code
6       1     flags: bit 0 = payload was deflate-compressed (raw deflate) before encryption
7       1     KDF id: 1 = scrypt
8       1     scrypt log2(N)
9       1     scrypt r
10      1     scrypt p
11      16    salt (random)
27      24    XChaCha20-Poly1305 nonce (random)
51      n+16  ciphertext + 16-byte Poly1305 tag
```

- Key: `scrypt(NFKC(passphrase) as UTF-8, salt, N, r, p, dkLen 32)`.
- Cipher: XChaCha20-Poly1305. The **whole 51-byte header is the AAD**, so changing the version, kind,
  flags or KDF parameters makes decryption fail (no downgrade of the KDF cost, no kind swapping).
- Default KDF: `logN 16, r 8, p 2` (64 MiB of memory), sized to run on a phone in about a second.
  Readers accept `logN` 12..18, `r` 1..16, `p` 1..4 and refuse anything else before running scrypt, so a
  crafted file cannot make a device allocate gigabytes.
- Payload of a backup file: JSON `{ v: 1, created, secret (64 hex), profile?, contacts?, blocked?, muted?, settings?, chats?, photo?, pins? }`,
  compressed when the platform supports it. A restored file is treated as untrusted input and every field
  is validated like data from another device.
- Payload of a recovery code: the 32 raw secret bytes, not compressed. The code is the container in
  Crockford base32 (no `I L O U`; `I`/`L` read as 1, `O` as 0), shown in groups of five. The QR code
  carries the compact form.
- Files are named `miga-backup-YYYY-MM-DD.miga`.

## Versioning

The version byte is checked first. A file with a newer version, or an unknown KDF id, is refused with an
"update MIGA" message instead of being guessed at. Changing any field layout or algorithm means bumping the
version; old versions must stay readable. Unit tests (`npm test` in `web/`) cover round trips, wrong
passphrase, tampered header and ciphertext, KDF limits and recovery code text handling.

## Threat notes

- **The passphrase is the whole defence.** Anyone holding the file or code can try passphrases offline.
  scrypt makes each guess cost 64 MiB and real time, but a short or common passphrase still falls. MIGA
  requires at least 10 characters and shows a strength hint; use a long phrase of unrelated words.
- **There is no recovery for a forgotten passphrase.** Nobody, including the project, can open the file.
- **Never upload a backup** to anything you do not control, and do not post the QR code or code. A backup
  with the right passphrase is the account: whoever restores it can read and send as that address.
- The backup file with history contains message text in readable form once decrypted; keep it as
  carefully as the device.
- Restoring does not revoke the old device. If a device or backup may be exposed, restore elsewhere and
  stop using the old address; there is no remote logout.
- The secret is held in memory while the dialog is open and is not written to logs or to the relay.
- "Erase this device" warns when no backup exists, because after erasing the address is gone for good.
