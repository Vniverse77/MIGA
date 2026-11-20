# MIGA client engine specification (protocol v0)

Status: describes what the web client (`web/src/lib/*.ts`, `web/src/lib/app/Messenger.svelte`) **actually does**
at the time of writing. It is the reference for other clients (the Rust CLI). Where the code and
[PROTOCOL.md](PROTOCOL.md) agree, this document links instead of repeating. Where behaviour is unclear or
looks accidental it says **OPEN** and does not guess. Machine-checkable examples for almost every rule are in
`protocol/test-vectors/` (see [protocol/README.md](../protocol/README.md)); a vector name is written like
`envelope.json: text_plain`.

Conventions: "UTF-16 units" means JavaScript `String.length`. "hex" is always lowercase. "base64" is standard
base64 with `=` padding (`btoa`/`atob`). "Now" is `Date.now()` in milliseconds. Source references are
`file:function`.

## 1. Primitives

| Use | Primitive | Source |
|---|---|---|
| Signatures, identity | Ed25519 (RFC 8032, deterministic) | `crypto.ts` (noble-curves) |
| Key agreement | X25519 on keys **converted** from Ed25519 | `edwardsToMontgomeryPriv/Pub` |
| KDF | HKDF-SHA256 | `hkdf(sha256, ikm, salt, info, 32)` |
| AEAD | XChaCha20-Poly1305, 24-byte nonce, 16-byte tag appended | noble-ciphers |
| Link-code KDF | scrypt N=2^15, r=8, p=1, dkLen 64 | `devices.ts:deriveLink` |
| Hashes | SHA-256 (files), SHA-512 (key conversion, safety number) | |

Nothing else is used. All randomness comes from `crypto.getRandomValues` (noble `randomBytes`).

## 2. Identity

- An identity is a 32-byte **seed** (the Ed25519 "secret key" of RFC 8032, not the 64-byte expanded key).
  `newIdentity()` = `ed25519.utils.randomPrivateKey()` (32 random bytes).
- `address` = lowercase hex of the Ed25519 public key derived from the seed (64 chars).
  Vectors: `identity.json` (includes the two RFC 8032 section 7.1 keys).
- The seed is stored as 64 hex chars (`storage.ts`: `miga.identity`). A stored value that is not `^[0-9a-f]{64}$`
  is treated as "no identity".
- **Two kinds of identity exist per device.** The *account identity* (shared by all devices of one account; its
  address is what contacts write to) and a *device identity* (random seed made on first start, never shared;
  used only for device-to-device sync, section 12). Both use the same format and the same relay auth.
- Signing for relay auth: `sig = Ed25519.sign(utf8("miga-auth-v0:" + nonceHex), seed)` where `nonceHex` is the
  **hex string** from the relay's challenge (the string's UTF-8 bytes are signed, not the decoded nonce).
  128 hex chars out. Vectors: `auth.json`.

### 2.1 Ed25519 to X25519 conversion

MIGA has no separate X25519 keys. Both parties convert:

- Public: `edwardsToMontgomeryPub(address bytes)`: the standard birational map `u = (1 + y) / (1 - y)` mod
  2^255-19 on the decoded Edwards point, encoded as 32 bytes little endian.
- Secret: `edwardsToMontgomeryPriv(seed)` = the first 32 bytes of `SHA-512(seed)`, **clamped**
  (byte 0 `&= 248`, byte 31 `&= 127`, byte 31 `|= 64`). This is the same scalar Ed25519 uses for signing.
  Vectors give both the unclamped hash prefix and the returned value (`identity.json: sha512_first32,
  x25519_secret`) and `x25519_public`.
- `shared = X25519(secret_converted, public_converted)`. noble throws when the result is all zero.

## 3. Addresses

`isAddress(s)` is true iff **both**:

1. `s` matches `^[0-9a-f]{64}$` (lowercase only; uppercase, whitespace, `0x` and non-ASCII digits are rejected), and
2. converting it with `edwardsToMontgomeryPub` and running one X25519 with a fixed probe scalar (32 bytes of `0x07`)
   does not throw.

Step 2 rejects: bytes that do not decode to an Edwards point, the identity and all small-order points (their
conversion or the DH degenerates), and non-canonical encodings of y (observed: y = p, p+1, p+2 are rejected).
Vectors: `address.json` (valid, small-order, non-canonical, random 32-byte strings; about 1 in 8 random strings
is not a point). **OPEN:** the exact predicate for every possible 32-byte string is "whatever noble does"; the
vectors are the oracle, a reimplementation must be checked against them (sign-bit handling when x = 0 is not
covered by a vector).

- **The relay is weaker:** it accepts any 64-char lowercase hex string as an address (`isAddr` in `relay/main.go`).
  Only clients check the curve.
- Where addresses are accepted from the user: add contact lowercases and trims first (`newAddress.trim().toLowerCase()`),
  then `isAddress`, then refuses the user's own account address. The invite link `#to=<address>&name=<label>`
  (`name` trimmed, at most 40 UTF-16 units) and the QR scanner use the same check. The invite fragment never
  leaves the client.
- A message from an unknown address creates a contact (name = the sender's shared name or a placeholder) unless the
  sender is blocked.

## 4. Pair key

For me (account seed `s`, address `a`) and peer address `p`:

```
shared = X25519(edwardsToMontgomeryPriv(s), edwardsToMontgomeryPub(p))
info   = utf8( [a, p].sort().join("") )          // two lowercase hex strings, sorted as strings, concatenated: 128 chars
key    = HKDF-SHA256(ikm = shared, salt = utf8("miga-v0"), info, 32 bytes)
```

Same key both directions. Sorting is JavaScript default string sort, which for lowercase hex equals byte order.
Vectors: `pair-key.json`. PROTOCOL.md "Encryption" describes the same thing.

## 5. Envelope (message body)

`body = base64( nonce[24] || XChaCha20-Poly1305(key, nonce, padded, aad = empty) )`

- `padded` = UTF-8 bytes of the plaintext JSON, followed by `0x20` bytes up to the next multiple of 256. A JSON of
  exactly 256, 512, ... bytes gets **no** extra block. Padding counts **bytes**, not characters. Because JSON allows
  trailing whitespace, the receiver does not unpad, it just parses (`padding.json`).
- `nonce` = 24 fresh random bytes per message. No counter, no derivation.
- **No AAD** for pairwise messages and link bundles. **AAD = `utf8(senderDeviceAddr + recipientDeviceAddr)`**
  (two 64-char hex strings concatenated, sender first) for device sync messages (section 12).
- The sealed length is `24 + padded + 16` bytes; the relay limit (24 000 base64 chars) allows a padded plaintext of
  roughly 17 900 bytes. The client does not check the size before sending (see OPEN list).
- Receiving: base64-decode, split nonce (first 24 bytes), decrypt, UTF-8 decode, `JSON.parse`. Any failure at any
  step means "unreadable" (`decrypt` returns null). A readable envelope with `v !== 0` is also unreadable.
  Unreadable bodies are **still acknowledged** to the relay so they do not clog the queue.

## 6. Payload JSON

All payloads are JSON objects with `"v":0`. Unknown fields are ignored (never reject). Key order is irrelevant.
`ts` is the sender's clock in ms; the receiver parses it as `Number(x) || Date.now()` (so `"1234"` works, `0`,
`NaN` and garbage become "now"; floats are kept).

`decrypt()` classification (the order matters; first match wins). Let `P` be the parsed object.

1. `P.v !== 0` -> unreadable.
2. `P.text` is **not a string** -> control message. In order:
   1. `del`: `cleanIds(P.del)` non-empty -> delete request (`{text:"", ts, del}`).
   2. `edit`: `cleanEdit(P.edit)` not null -> edit.
   3. `live`: `typeof P.live?.text === "string"` -> live frame, text sliced to 4000 UTF-16 units.
   4. `ack` / `seen`: `cleanIds` of each; if either non-empty -> receipt (both can be present).
   5. otherwise unreadable (e.g. an `ack` with only invalid ids, or `live` as a bare string).
3. `P.text` is a string -> ordinary message. Note a message with both `text` and `del` is an ordinary message.
   - `att`: if `P.att` is present (even `null`) it must pass `cleanAtt`, else the **whole message is dropped**.
     With a valid `att`, the shown text is the caption `P.cap` (string, sliced to 4000 units; missing = empty) and
     `P.text` is ignored.
   - `name`: kept only if a string (not cleaned by decrypt).
   - `reply`: `cleanReply` or dropped (the message stays).
   - The text is **not** length-limited or trimmed by `decrypt`. `Messenger` slices received text to 4000 units
     (`slice`, not reject).

Vectors: `envelope.json` (real encrypt of every kind), `envelope-raw.json` (the leniency rules above),
`envelope-negative.json`.

### 6.1 Sender side (what `encrypt*` produce)

| Kind | JSON (before padding) | Notes |
|---|---|---|
| text | `{"v":0,"text":T,"ts":now[,"name":N][,"reply":R]}` | `name` only if non-empty; see 7.3 |
| attachment | `{"v":0,"text":T2,"cap":T,"att":A,"ts":now[,"name":N][,"reply":R]}` | `T2 = T + "\n" + PLACEHOLDER`, or just `PLACEHOLDER` when `T` is empty; `PLACEHOLDER = "[photo — update MIGA to view]"`; `A` has no `del` |
| delete | `{"v":0,"ts":now,"del":[ids]}` | `cleanIds` applied: dedup, invalid dropped, at most 50 |
| edit | `{"v":0,"ts":ts,"edit":{"id":ID,"text":T}}` | `ts` explicit (see 9) |
| ack / seen | `{"v":0,"ts":now,"ack":[ids]}` or `"seen"` | `cleanIds`, max 50 per message; an empty list is unreadable |
| live | `{"v":0,"ts":now,"live":{"text":T}}` | `T` sliced to 4000 units; empty = cleared; sent as an ephemeral frame |

Key order on the wire is `v`, `text`, `cap`, `att`, `ts`, `name`, `reply` for messages (irrelevant to receivers).
Profile name is carried as `name` in ordinary messages (section 7.3). There is no separate profile message.

### 6.2 Field validators

- **Id** (`ID_PATTERN`): `^[A-Za-z0-9_-]{1,64}$`. Message ids generated by the client are 32 hex chars (`randomId`: 16 random bytes).
- **`cleanIds(v)`**: non-array -> `[]`; keep strings matching the id pattern; dedup (first occurrence wins); at most 50.
- **`cleanEdit(v)`**: object with valid `id`, string `text`; `text.length <= 4000` is checked **before** trimming (so
  4000 chars plus one space is rejected); then `trim()`; empty after trim -> null. Output `{id, text: trimmed}`.
- **`cleanReply(v)`**: valid `id`; `from` passes `isAddress` (lowercase only); `text` is a string. Preview =
  `text.slice(0, 2000)` (UTF-16 units, may cut a surrogate pair in half), `trim()`, first line split on `\r?\n`,
  `trim()` again, then the first 120 **code points** (`[...line].slice(0,120).join("")`). Empty -> null (the reply is dropped).
- **`cleanAtt(v, withDelete=false)`**: see section 11. Vectors: `validators.json: clean_att`.
- **Profile name** (`cleanName`): string -> `trim()`, collapse every `/\s+/` run to one space, `slice(0, 40)` UTF-16 units
  (may cut a surrogate pair); non-string -> `""`.
- **JS whitespace** for `trim()` and `\s`: the ES WhiteSpace and LineTerminator set. The exact 25 code units are in
  `validators.json: js_whitespace_code_units` (TAB, LF, VT, FF, CR, space, NBSP, U+1680, U+2000-200A, U+2028, U+2029,
  U+202F, U+205F, U+3000, U+FEFF). It **excludes** U+0085 and U+200B and U+180E, unlike Rust's `str::trim`.

### 6.3 Limits

- `MAX_TEXT = 4000` UTF-16 units for a message, a caption, an edit, a live text. The UI refuses longer input
  (`text.length > MAX_TEXT` after `trim()`); the composer also has `maxlength=4000`. Emoji count 2 units each
  (`validators.json: utf16_lengths`).
- Reply preview 120 code points; name 40 units; `MAX_DELETE = 50` ids per message/receipt.
- Attachment caption: `draft.trim().slice(0, 4000)` (sliced, not rejected).

## 7. Messages: sending, state and identity details

### 7.1 Send pipeline (`sendMessage`)

1. `text = draft.trim()`; empty -> nothing. `text.length > 4000` -> refuse with a notice. Not connected to a chat -> nothing.
2. Create local message `{id: randomId(), mine: true, text, ts: now, state: "pending", reply?}` and persist it **before** sending.
3. If the relay connection is ready, send `{"t":"send","to":peer,"id":id,"body":encrypt(...)}`. Offline: it stays `pending`.
4. Relay answers `{"t":"sent","id"}` -> state `sent` (and a `msg` copy goes to the account's other devices).
5. Relay answers `error` with an `id` -> state `failed` plus a notice. `failed` is **never retried automatically**.
6. On every `ready`, every `pending` message is encrypted again (new nonce, **fresh** `ts`/`name`) and re-sent with the **same id**.
   The relay ignores duplicate `(sender, id)` (`INSERT OR IGNORE`, still answers `sent`).

`delivery` (`delivered` after an `ack` receipt, `read` after `seen`) is separate from `state`; it never goes backwards
(rank delivered 1, read 2). An `ack` also lifts `pending` to `sent`.

### 7.2 Timestamps

- A **sent** message's `ts` is the sender's local `Date.now()` at creation (stored locally; the wire `ts` inside the
  ciphertext is `Date.now()` at encryption time and is only used for edits and control messages).
- A **received** message's `ts` is the **relay's** `ts` from the `msg` frame, not the payload `ts`. This is the ordering key.
- `OPEN`: the relay `ts` is used unvalidated (a missing or non-numeric `ts` frame field becomes `NaN`).

### 7.3 Profile name

`profile = {name, share}`. The effective name is `cleanName(profile.name)`; it is attached as `name` to every ordinary
message only when `share` is true and the cleaned name is non-empty. A receiver updates a contact's name from `name`
(`ensureContact`: trim, collapse whitespace, 40 units) only if the contact exists, has no user-typed name
(`custom` unset), and `name` is non-empty. A new contact gets the shared name or a localized placeholder.
Names typed by the user when adding a contact are `trim()`ed but not collapsed or length-capped (**OPEN**, see list).

## 8. Relay transport

JSON text frames over one WebSocket at `/ws` (PROTOCOL.md "Relay wire format" has the table). Engine behaviour on top:

### 8.1 Connect and auth (`relay.ts:RelayClient`)

1. Open `ws(s)://host/ws`. A native client sends **no `Origin`** header; the relay enforces origin patterns only when one is present.
2. Wait for `{"t":"challenge","nonce":<64 hex>}`; answer `{"t":"auth","pub":<address>,"sig":<128 hex>}`. The relay
   closes with policy violation on a missing frame within 15 s, an invalid address, or a bad signature.
3. `{"t":"ready"}`: mark ready, reset backoff to 1 s, start a ping timer of **30 s** (`{"t":"ping"}`, answer `pong` is ignored),
   clear the "ephemeral unsupported" flag, then run the ready hook (resend pending, flush acks, check seen).
4. The relay then pushes every queued message for this address, oldest first (`ORDER BY ts`).
5. On close/error: status offline, retry after `backoff` (1 s doubling to a cap of 30 s). No retry after an explicit `close()`.
   **OPEN:** the client never detects a dead socket itself (no pong timeout); it relies on the browser closing it.

A device keeps **two** such connections (account key and device key, section 12).

### 8.2 Frames the engine sends and handles

| Frame | Engine behaviour |
|---|---|
| `send` `{to,id,body}` | refused locally (returns false) when not ready; id = message id for chat messages and `randomId()` for control messages, receipts, sync |
| `send` with `eph:true` `{to,eph:true,body}` | live typing only; no id; never queued; throttled to one per ~300 ms (trailing edge) |
| `sent` `{id}` | marks the message `sent` |
| `msg` `{from,id,body,ts}` | receive pipeline (section 9); `ack` frame sent back only if the handler returns true |
| `msg` with `eph:true` | live handling; **never** acknowledged |
| `ack` `{from,id}` | sent after the message is stored locally (or was deliberately dropped) |
| `unsend` `{to,id}` | fire and forget after a "delete for everyone"; a `bad_frame` without `id` answered by an old relay is ignored |
| `error` `{err,id?}` | `bad_frame` without id is ignored; with id marks that message `failed`; otherwise shows a notice. A `bad_frame` without id within 1.5 s of a live frame disables live sending until reconnect |
| `ping`/`pong` | keep-alive |

Relay rules the engine depends on (`relay/main.go`): body 1..24 000 chars; ids `^[A-Za-z0-9_-]{1,64}$`; 30 `send`+`unsend`
frames per 10 s per connection (`rate_limited`); 10 ephemeral frames per second; 1 000 queued messages per recipient
(`queue_full`); 30 days retention; idle close after 90 s; WS read limit `maxFrameBytes` (32 KiB per the plan; see relay).
The client has **no** global send pacing for chat traffic; only device sync is paced (section 12). A burst of acks and
messages can exceed 30 per 10 s (**OPEN**, not observed to matter).

## 9. Receive pipeline (`onMessage` for the account connection)

Order is significant. Return value `true` means "acknowledge to the relay".

1. Sender is in the block list -> return true (acked, dropped, no trace).
2. `decrypt(me, from, body)`; unreadable -> true.
3. `live` present -> true (dropped; ephemeral frames use a separate path, a queued one is ignored).
4. `del`: remove those ids from the chat with `from`, only among messages where `mine === false`; record message
   tombstones (`s:"m"`, `mine:false`, `ts: now`); true.
5. `edit`: apply to a message of **that sender** only (`mine:false`); `ts = editTime(plain.ts)`; forward as a `edit` sync
   message if applied; true.
6. `ack`/`seen`: `ack` marks own messages `delivered`; `seen` marks `read` **only if the read-receipts setting is on**;
   statuses never go backwards; applied changes are forwarded as `st`; true.
7. Message tombstone matches `(from, id, mine:false, relay ts)` -> true (dropped).
8. Clear a pending contact tombstone if the message is newer than it; hide the live line; create/update the contact.
9. Store `{id: relay id, mine:false, text: text.slice(0,4000), ts: relay ts, state:"received", reply?, att?}` by merging
   into the chat (dedup, section 13). If new: forward a `msg` copy to other devices, update unread/notification.
10. Queue a delivery receipt for the id (also for a re-delivery) and return true.

`ack` receipts are batched: flushed 1 s after the first queued id, per peer, at most 50 ids per receipt message; ids that
could not be sent while offline wait for the next `ready`. They are not sent to blocked peers. `seen` receipts are sent
only when the chat is open, visible and scrolled to the bottom, and the setting is on (in chunks of 50). Receipts, edits,
deletes and live frames are never themselves receipted.

Delete for everyone (sender): send the `del` message first (needs a ready connection; otherwise nothing changes anywhere),
then `unsend` for the original, then `DELETE /blob/{id}` with the delete token if it has an attachment, then remove locally
and record a tombstone. Edit (sender): only for own messages in state `sent`; `text.trim()`, non-empty, at most 4000 units,
different from the current text; `ts = max(now, edited + 1)`; sent first, applied locally only if the send succeeded.

`applyEdit` rules (vectors `validators.json: apply_edit`): look up `(mine, id)` in the list; unknown id ignored; text
cleaned with `cleanEdit`; `ts = editTime(ts)` = `Number(ts)`, valid and `> 0` -> `min(ts, now + 86 400 000)`, else `now`;
ignored when `ts <= target.edited` (default 0); otherwise `edited = ts` and the text is replaced.

## 10. Control, tombstones and read state

PROTOCOL.md covers tombstones, history pull, read state and receipts in detail; the engine adds:

- Tombstone key: `m|chat|m-or-t|id` for messages (`m` = mine, `t` = theirs) and `c|chat` / `k|chat` for conversation/contact.
  A conversation/contact tombstone covers messages with `ts <=` its `ts` (the relay `ts` for received messages).
- `cleanTombs`: drops items with an invalid chat address, `ts` not finite, `<= 0` or more than 24 h ahead; floors `ts`;
  `m` requires a valid id and a boolean `mine`; at most 500 items read per message; 5000 kept; pruned after 90 days.
- A block list holds at most 500 addresses; mute list uses the same cap.
- Vectors: `sync-logic.json` (`add_tombs`, `tomb_filter_checks`, `clean_tombs`).

## 11. Attachments

Crypto and message payload are in PROTOCOL.md "Attachments". Engine details:

- `cleanAtt` (`validators.json: clean_att`): `blob` `^[0-9a-f]{32}$`; `key` 64 hex; `nonce` **48** hex; `hash` 64 hex;
  `mime` one of `image/jpeg|png|webp|gif`, `video/mp4|webm` (HEIC, SVG, audio rejected); `size` integer 1..26 214 400
  (25 MiB; `"100"` as a string is accepted via `Number`); `w`,`h` `Math.round`ed, each in 1..20000; `thumb` kept only if it
  matches `^data:image/(webp|jpeg|png);base64,[A-Za-z0-9+/=]{0,4000}$`, else `""`; `del` kept only when `withDelete` is
  true and it is 32 hex. A message whose `att` fails is dropped entirely. `del` is never put on the wire to the recipient
  but is kept (and synced) on the sender's own copy.
- Upload: `PUT {origin}/blob` with the raw ciphertext body (origin = relay origin, `ws`->`http`, `wss`->`https`), no
  special headers needed. `201 {"id","del","size","expires"}`; map `413 too_big`, `507 quota`, `429 rate`, other -> upload
  failure. The returned `id` becomes `att.blob`. The relay has a 25 MiB + tags cap and 30 uploads / 10 min / IP.
- The message (with `att`) is sent only **after** the upload succeeds, then follows the normal send pipeline (the pending
  message carries the attachment and is re-sent on reconnect). The user's caption is the message text.
- Download (`fetchMedia`): `GET {origin}/blob/{id}`; `404` = gone (30-day TTL or deleted by the sender), other non-2xx =
  network error. Decrypt per chunk, then check exact length (`size + count*16`), then `SHA-256(plain) == hash`; any failure =
  corrupt, nothing is shown. Decrypted media is cached locally by blob id and removed when its message is deleted.
- Chunk nonce: base XOR big-endian 64-bit chunk index in the last 8 bytes; AAD `0x01` last chunk, `0x00` otherwise;
  chunk size 65 536 plaintext bytes; a file of exactly 65 536 bytes is **one** chunk (no trailing empty chunk); an empty file is one empty chunk.
  Vectors: `file-chunks.json` (including a chunk-nonce table beyond 2^32).
- Truncating a multi-chunk ciphertext at a chunk boundary is caught first by the length check, and also by the AAD flag.
- Sender-side image processing (decode, 2048 px limit, strip metadata, WebP/JPEG re-encode, 24 px thumbnail under 2 000
  characters) is a browser feature and is **not** part of the protocol; another client may send file bytes as they are
  as long as `cleanAtt` accepts the metadata.

## 12. Multiple devices

PROTOCOL.md "Linked devices" is the authority for the flows; the engine details:

- **Connections:** the account connection (account key, chat traffic) and the device connection (device key, sync).
  Both authenticate and ack like any client. Messages for the account address go to **every** online device of the
  account at once; each device stores it. A device that was offline gets the copy via a `msg` sync message
  from a device that was online (and eventually via a history pull).
- **Sync key** = `HKDF-SHA256(ikm = account seed (32 bytes), salt "miga-v0", info "sync", 32)`.
- **Sync body:** same sealing as section 5 but the plaintext is a `SyncMessage` JSON (no `v`), key = sync key and
  AAD = `utf8(senderDeviceAddr + recipientDeviceAddr)`. The receiver uses AAD `utf8(frame.from + ownDeviceAddr)`, so a
  message cannot be replayed to another device or in the opposite direction. Unreadable sync bodies are acked.
  Vectors: `sync-seal.json` (wrong AAD, swapped AAD, empty AAD and wrong key all fail).
- **Fan-out:** `syncAll(message)` appends one sealed message **per other device** to an outbox. The outbox is paced:
  one frame per 400 ms, and a frame leaves the queue only if `send` returned true (connection ready). The outbox is in
  memory only (lost on restart; the history pull and tombstones heal it).
- **What fans out:** a stored incoming or sent message (`msg`, after `sent`), applied edits, applied receipts (`st`),
  tombstones (`tomb`, 100 per message), read marks (`read`), contacts (`state`, 50 per message), profile, block/mute lists
  (`state`), receipts setting, device list changes, `bye`.
- **Sync message validation** (every field from another device is untrusted): `cleanMessage` (valid id, string text, boolean `mine`,
  finite `ts`; state forced to `sent`/`failed`/`received`, never `pending`; text sliced to 4000; `att` via `cleanAtt` with
  `del` kept only for own messages; optional `edited`, `delivery`), `cleanContact` (valid address, non-empty cleaned name,
  `verified` only if it equals the locally computed safety number), `cleanDevices` (at most 20, valid unique addresses,
  label cleaned or `"Device"`, `added` number or now), `cleanBlocked`, `cleanCursor`, `cleanTombs`.
  Vectors: `sync-logic.json`.
- **Linking** (code flow in PROTOCOL.md): code = 12 chars of `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, each `randomByte & 31`
  (uniform). `normalizeLinkCode`: uppercase, strip every char outside `[0-9A-Z]`, `O -> 0`, `I|L -> 1`, length must be 12,
  every char must be in the alphabet (so `U` is invalid). Display form groups of 4 with `-`. `deriveLink(code)` =
  scrypt over `utf8(normalized code)`, salt `utf8("miga-link-v0")`; bytes 0..32 are the mailbox **seed**, 32..64 the
  bundle key. The bundle is sealed like a message (padding, random nonce) with **no AAD**. The new device accepts a bundle only if
  `k === "link"`, `secret` is 64 lowercase hex, `sponsor` is a string and `exp > now`; anything else is acked (deleted) and ignored.
  The sponsor re-checks nothing; the code TTL is 10 minutes (`LINK_TTL_MS`). Vectors: `link.json`.
- **History pull:** stop-and-wait pages of about 12 000 bytes (`historyPage`: canonical order chat address ascending, then
  `ts`, then `id` with `mine` as the last tiebreak; a page always has at least one message; message size counted as
  UTF-8 length of its JSON + 20). Retry after 20 s without answer; after three tries ask the next device.
  Vectors: `sync-logic.json: history_pages`.

## 13. Ordering and de-duplication

- **Incoming duplicates:** the relay may re-deliver until acked; the engine treats `(chat, mine, id)` as the key.
  `mergeMessages` never replaces an existing message; it only adopts a newer `edited` text and a higher `delivery` (own
  messages only), and keeps the list sorted by `ts` (stable sort, so equal `ts` keep arrival order). The message id is
  chosen by the sender and is **not** validated for uniqueness across senders, so the same id can exist in both
  directions of one chat (`mine` is part of the key).
- A re-delivered message is still acknowledged (delivery receipt) and still acked to the relay.
- **Display order:** ascending by `ts` (relay time for received, local time for sent). No other ordering is applied.
- **Receipts** are idempotent; **tombstones** make deletes permanent for 90 days.
- Vectors: `sync-logic.json: merge_messages`.

## 14. Error handling summary

| Situation | Engine behaviour |
|---|---|
| Relay frame is not JSON / unknown `t` | ignored |
| Auth rejected | socket closed by relay; retry with backoff (no distinct handling) |
| `rate_limited`, `too_large`, `queue_full` with id | message `failed`, notice shown; no retry |
| Not connected when sending | message stays `pending` (chat), or the action is refused (delete, edit, live) |
| Unreadable / wrong-key body | acked and dropped, no UI |
| `att` invalid | whole message dropped (acked) |
| Blocked sender | acked and dropped |
| Blob `404` | "gone" placeholder, no retry |
| Blob decrypt/hash failure | "corrupt", file not shown |
| Link bundle expired / malformed | acked, ignored; the typed code attempt times out |
| Sync message bad AAD / key | acked, ignored |

## 15. OPEN items

1. **Address predicate:** `isAddress` is defined by noble's behaviour (conversion plus a probe DH). Only the vectors define
   edge cases (sign bit with x = 0, other non-canonical forms are untested).
2. **Body size:** no client-side check that a sealed body fits 24 000 base64 chars (a 4000-unit text with many emoji
   escapes can approach it; sync `state` messages with 50 long-named contacts likewise). The relay answers `too_large`.
3. **User-typed contact name** (add contact) is only `trim()`med: no 40-unit cap, no whitespace collapse, unlike shared names.
4. **Sender `name`** is not cleaned by `decrypt`; cleaning happens in `ensureContact` (and only when a contact exists or is created).
5. **Relay frame `ts`** is not validated (NaN possible).
6. **No dead-socket detection** on the client (ping is sent, `pong` is never awaited).
7. **No chat pacing** against the relay's 30 sends / 10 s limit (only sync is paced); bursts of acks plus messages are
   unconstrained. Rate-limit errors with an id mark that message `failed` permanently.
8. **`failed` messages are never retried** automatically; the UI offers no resend for chat messages (attachments have retry). Verify before copying.
9. **Duplicate JSON keys** and extreme nesting: `JSON.parse` keeps the last duplicate; behaviour of other parsers may differ.
10. **Lone surrogates:** `slice` on UTF-16 units can leave a lone surrogate in names and reply previews; JSON can carry it
    (`\udXXX`) but a Rust `String` cannot. The expected CLI behaviour (replace, drop, keep as UTF-16) is undecided.
11. **Edit/delete of messages the receiver never stored** is ignored silently; there is no "pending edit" memory.
12. **Contact `verified` / key-change** logic and unread/mute/notification UI state are application behaviour, not protocol,
    and are not specified here.
13. **Time skew:** tombstone and edit timestamps use each device's own clock (edits clamp 24 h ahead; tombstones reject more than 24 h ahead).
14. **Device list trust:** any holder of the sync key can add or remove devices (`state`, `bye`); there is no further authentication.
15. **Unicode:** no normalization (NFC/NFD) or case folding is applied to names, texts or addresses beyond `toLowerCase()` on typed addresses.
