# MIGA protocol v0

Status: experimental. Not audited. Do not rely on it for safety-critical communication yet.

## Goals

- Text messaging that works from restrictive networks: everything travels as ordinary
  WebSocket-over-TLS on port 443, which looks like normal HTTPS traffic.
- The relay is "dumb": it forwards and briefly stores ciphertext. It never sees plaintext
  and keeps no accounts, phone numbers or e-mail addresses.
- The transport is replaceable. The same encrypted envelope can later travel over a direct
  peer-to-peer link (WebRTC data channel, LAN, another relay) without changing the crypto.

## Identity

- An identity is an Ed25519 key pair generated on the device.
- The **address** of a user is the public key as 64 lowercase hex characters.
- The secret key never leaves the device.

## Encryption (client to client)

1. Both Ed25519 keys are converted to X25519 (Montgomery form).
2. `shared = X25519(my_secret, peer_public)`
3. `key = HKDF-SHA256(ikm = shared, salt = "miga-v0", info = sort(addrA, addrB) joined, 32 bytes)`
4. Plaintext is JSON `{"v":0,"text":"...","ts":<unix ms>}` with an optional `"name"` (the
   sender's display name, at most 40 characters, sent only if the sender chose to share it;
   the relay never sees it) and an optional `"reply"` (below), padded with spaces to a multiple
   of 256 bytes (hides exact message length).
   `"reply"` quotes an earlier message: `{"id":"<id of the original>","from":"<address of its
   sender>","text":"<preview>"}`. `id` follows the relay's id rules, `from` is an address, and
   `text` is the first line of the original, trimmed, at most 120 characters. It exists only
   inside the ciphertext. Receivers drop a `reply` that fails these checks and treat the message
   as a normal one; clients that do not know the field ignore it. The quote is a hint for display
   and is not verified against the original.

   **Delete request.** Instead of `"text"` the plaintext may carry `"del":["<id>",...]`
   (`{"v":0,"ts":..,"del":[...]}`): a control message, shown as no bubble, asking the receiver to
   remove those messages that came from the sender. At most 50 ids, each following the relay's id
   rules; invalid ids are dropped. The receiver removes them only from the chat with the sender
   and only among messages the sender wrote, never among its own, and ignores the request if
   nothing matches. It never creates a contact. A message that has both `text` and `del` is an
   ordinary message. Clients that predate this field require a string `text`, fail to read the
   payload and acknowledge and discard it: no bubble, no error (checked against v0.4.0).
5. `body = base64(nonce(24 random bytes) || XChaCha20-Poly1305(key, nonce, plaintext))`

Known limits of v0: no forward secrecy and no post-compromise security (a stolen secret key
decrypts past messages that were recorded). A ratchet (Double Ratchet or MLS) is planned.

## Relay wire format

JSON text frames over one WebSocket at `/ws`. Field `t` is the frame type.

| Direction | Frame | Meaning |
|---|---|---|
| relay → client | `{"t":"challenge","nonce":"<64 hex>"}` | sent right after connect |
| client → relay | `{"t":"auth","pub":"<addr>","sig":"<128 hex>"}` | `sig = Ed25519("miga-auth-v0:" + nonce)` |
| relay → client | `{"t":"ready"}` | authenticated; queued messages follow |
| client → relay | `{"t":"send","to":"<addr>","id":"<id>","body":"<base64>"}` | `id`: 1–64 chars of `[A-Za-z0-9_-]`, unique per sender |
| relay → client | `{"t":"sent","id":"<id>"}` | relay stored the message |
| relay → client | `{"t":"msg","from":"<addr>","id":"<id>","body":"<base64>","ts":<unix ms>}` | delivery |
| client → relay | `{"t":"ack","from":"<addr>","id":"<id>"}` | recipient has it; relay deletes its copy |
| client → relay | `{"t":"unsend","to":"<addr>","id":"<id>"}` | sender takes back a message that is still queued |
| relay → client | `{"t":"unsent","id":"<id>","found":true\|false}` | `found` is false if it was already delivered, acknowledged or never existed |
| client → relay | `{"t":"ping"}` → `{"t":"pong"}` | keep-alive (send at least every 60 s) |
| relay → client | `{"t":"error","err":"<code>","id":"<id>"}` | `bad_frame`, `too_large`, `rate_limited`, `queue_full` |

Rules enforced by the relay:

- `body` is at most 24 000 characters.
- `unsend` deletes only a message whose sender is the authenticated connection; nobody can
  unsend another address's messages. It counts against the `send` rate limit. A relay that
  predates it answers `bad_frame` (without `id`); clients ignore that.
- A message stays stored until the recipient acknowledges it or 30 days pass.
- At most 1 000 undelivered messages are kept per recipient.
- At most 30 `send` frames per 10 seconds per connection.
- A connection that sends nothing for 90 seconds is closed.

Clients must de-duplicate deliveries by `(from, id)`: a message is re-sent on every
reconnect until it is acknowledged.

## Linked devices

One account can be used on several devices. The relay is not involved beyond forwarding
opaque bodies: it keeps no account, no device list and no code.

**Keys.** All devices of an account hold the same account key. Each device also has its own
*device key* (Ed25519, made on that device, never shared). A device keeps two connections
to the relay: one as the account address, one as its device address.

**Linking with a code.** The device that already has the account shows a one-time code:
12 characters of Crockford base32 (60 bits).

1. `out = scrypt(code, salt = "miga-link-v0", N = 2^15, r = 8, p = 1, 64 bytes)`.
   `out[0..32]` is the secret of a throwaway *mailbox* key, `out[32..64]` the bundle key.
2. The old device sends one message to the mailbox address. Its body is
   `base64(nonce || XChaCha20-Poly1305(bundle key, nonce, bundle))`, where the bundle is JSON
   `{"k":"link","secret":<account secret hex>,"sponsor":<device address>,"exp":<unix ms>,
   "profile":{...},"devices":[...]}`.
3. The new device derives the same two keys from the typed code, connects as the mailbox
   address, receives the bundle, rejects it if `exp` has passed, and acknowledges it (the
   relay then deletes it).
4. The new device makes its own device key and sends `hello` (below) to every device in the
   bundle. The sponsor answers with the profile, contacts, device list and recent history.

**QR code.** The old device also shows the code as a QR code containing
`<web origin>/app/#link=<code>` (packaged desktop and mobile builds use
`https://miga.vniverse77.com`). The QR code is only a carrier for the same code: nothing in the
protocol or its security changes. The part after `#` is never sent to a server. A phone's camera
app can open the link, or the in-app scanner reads it. A device that has no account opens
"Link this device" with the code filled in and waits for one tap on "Link" (it does not start by
itself, so a link received from someone else cannot silently move a new device into that
person's account). A device that already has an account ignores the link, shows a notice and
removes the fragment from the address bar. As with the typed code, whoever sees the QR code
within its 10 minutes can link a device, so the app warns: scan it only on your own device and
do not share a screenshot.

**Contact QR code.** Settings shows a QR code of the invite link
`<web origin>/app/#to=<address>` (plus `&name=<name>` only if the user shares a name). The
in-app scanner accepts only these two formats (`#link=` with a valid code, `#to=` with a valid
address) and rejects any other QR code.

A code is valid for 10 minutes. When it is used, cancelled or expires, the old device
connects as the mailbox and acknowledges whatever is there, so no copy of the bundle is
left. If the tab was closed first, this happens the next time the app is opened on that
device; until then the sealed bundle can stay on the relay for up to the normal 30 days.

**Sync between devices.** Messages between device addresses have the body
`base64(nonce || XChaCha20-Poly1305(sync key, nonce, JSON, aad = from || to))` with
`sync key = HKDF-SHA256(ikm = account secret, salt = "miga-v0", info = "sync", 32 bytes)`.
Only holders of the account key can make or read them, which is also how a device proves it
belongs to the account. JSON kinds:

| `k` | Meaning |
|---|---|
| `hello` | A new device announces itself: `label`, `sponsor`. |
| `state` | Any of `profile`, `contacts`, `devices` to merge, and `blocked`: the complete list of blocked addresses, which replaces the receiver's list (valid addresses only, at most 500). |
| `history` | `chats`: a piece of recent message history. |
| `msg` | A copy of one message just sent or received: `peer`, `message`, optional `name`. |
| `del` | `peer`, `items`: `[{"id","mine"}]` (at most 100). The receiver removes those messages from the chat with `peer`; `mine` says whether we wrote it. Sent for "delete for me" and after a delete request was applied. |
| `edit` | `peer`, `id`, `mine`, `text`, `ts`: an edit one device already applied (own edit, or one received from the peer), so the others show the same text. |
| `st` | `peer`, `ids`, `d` (`delivered` or `read`): a receipt one device already applied, so the others show the same ticks. `read` is applied only if read receipts are on. |
| `receipts` | `on`: the account-wide read receipts setting. |
| `bye` | `address` of a device that left or was removed. The named device erases itself. |

The relay pushes a message for the account address to every device online at that moment and
deletes it on the first acknowledgement; the receiving device forwards a `msg` copy so
devices that were offline get it too. Clients de-duplicate by message id.

**Limits to know.** Removing a device is cooperative: it erases itself the next time it
connects, but it did hold the account key. If a device is lost, the only real fix is a new
address. The relay can see that the account address and its device addresses connect from
the same IP and exchange messages, so it can tell which devices belong together.

## Deleting messages and blocking

- **Delete for me** removes a message on this device and, through `del`, on the linked devices.
  The other person keeps their copy.
- **Delete for everyone** (own messages only) sends the delete request above, sends `unsend`
  to the relay, and removes the message locally and on linked devices. It needs a relay
  connection; offline, nothing is deleted. If the recipient is offline, `unsend` removes the
  queued copy so it is never delivered; if the relay is an older one, the request still
  arrives later and does the job.
- **Block** is local state, synced between linked devices as `blocked`. Messages from a blocked
  address are acknowledged (so the relay deletes them) and dropped unread. The sender is not
  told. A deleted contact stays blocked until unblocked. Delete contact and "delete
  conversation" act on this device only.

Honest limits: deletion is a request, not a guarantee. The recipient may have read the message
already, may have a copy or screenshot, and a modified client can ignore the request. Clients
that predate the request silently ignore it, so the message stays on their side. A linked
device that was offline and later receives an old `history` snapshot can bring a deleted
message back. The relay's stored copy of an unsent message is deleted, but the relay can still
have seen that it existed. Blocking cannot stop a blocked address from sending; the relay
still carries and sees the messages until they are acknowledged.

## Delivery and read receipts

Receipts are control messages inside the normal end-to-end encrypted payload (same envelope as
messages; the relay sees an ordinary message). A control message has **no `text`**:

- `{"v":0,"ts":<ms>,"ack":["<id>", ...]}`: this device decrypted and stored these messages of
  yours. Sent in batches about 1 second after storing (also for a re-delivery, in case the first
  ack was lost). At most 50 ids per message. Always sent, except to blocked addresses.
- `{"v":0,"ts":<ms>,"seen":["<id>", ...]}`: the user looked at them. Sent only if the "read
  receipts" setting is on, while the chat is open, the page is visible
  (`document.visibilityState`) and scrolled to the end. With the setting off a client sends no
  `seen` and ignores incoming ones (like Signal, it works both ways). The setting is synced
  between linked devices (`receipts`).

Receivers apply them to their own messages with those ids: `sent` (relay accepted it) ->
`delivered` (`ack`) -> `read` (`seen`, only if the setting is on). A status never goes
backwards, `seen` implies delivered. The relay's own `ack` frame and its "queued" state do not
mean delivered. Control messages show no bubble, are not stored as messages, change no unread
state or chat order, and are never acknowledged with a receipt themselves (no loops). If the
recipient has several devices, each acks; the first one counts, repeats change nothing. A device
that applies a receipt forwards it to the sender's other devices as `st`.

Old clients: a payload without `text` and without `del` fails the old `text` check, so they drop
it silently (and acknowledge it to the relay). They never show a bubble, and they never send
receipts, so messages to them stay at one tick (sent).

## Editing messages

An edit is a control message, sealed like any other:

- `{"v":0,"ts":<ms>,"edit":{"id":"<message id>","text":"<new text>"}}`

There is no top-level `text`, so v0.5.0 clients fail their `text` check and drop it silently (and
acknowledge it to the relay); they keep showing the old text. Receiving rules:

- **Only the author edits.** The edit is looked up only among the messages that came from the
  sender of this very envelope (the sender is authenticated by the pairwise key), so nobody can
  change a message of another person, or one of the receiver's own messages.
- The target must still exist. After "delete for everyone" (or "delete for me") the message is
  gone and the edit is ignored; an edit that arrives for an unknown id is ignored too.
- `text` is trimmed, must not be empty (use delete instead) and at most 4000 characters, the
  same limit as a normal message. Anything else is dropped.
- Last writer wins by `ts`: an edit with a `ts` not newer than the one already applied is ignored.
  `ts` is clamped to one day ahead of the receiver's clock so a wrong clock cannot block later edits.
- Only the newest text is kept (no edit history); the bubble shows an "edited" label.
- An edit never creates a bubble, never counts as unread, never notifies and is never
  acknowledged with a delivery receipt. A quoted preview (`reply.text`) inside other messages is a
  snapshot and is not changed by a later edit.
- Both the sender and the receiver forward an applied edit to their other devices as a `edit`
  sync message. Only messages in state `sent` can be edited, and only while connected to the
  relay (like deleting for everyone).

## Attachments (photos, GIFs, video)

Files never travel inside the relay's message queue. The sender encrypts the file, uploads the
ciphertext to the relay's blob store over plain HTTPS, and sends the key inside a normal end-to-end
encrypted message. The relay stores opaque bytes and a size; it cannot tell a photo from noise.

### Blob API (same host and port as `/ws`)

| Request | Answer |
|---|---|
| `PUT /blob` (body = ciphertext) | `201 {"id":"<32 hex>","del":"<32 hex>","size":n,"expires":<unix ms>}` |
| `GET /blob/{id}` | `200` ciphertext (`Content-Type: application/octet-stream`, range requests work), `404` unknown or expired |
| `DELETE /blob/{id}` with header `X-Delete-Token: <del>` | `204`; `403` for a wrong token; `404` unknown |

- `id` and `del` are random 128-bit values. The relay keeps only `SHA-256(del)`.
- Errors on upload: `413` over the size limit (cut off while streaming, nothing is buffered in memory),
  `400` empty body, `429` more than 30 uploads per 10 minutes from one IP, `503` more than 4 uploads at once,
  `507` the storage quota is used up.
- Limits: 25 MiB of content plus the per-chunk tags (about 25.1 MiB on the wire), 30 days TTL (hourly
  cleanup), total quota `MIGA_BLOB_QUOTA` (default 2 GiB). Files live in `MIGA_BLOBS` (default `blobs/`
  next to `MIGA_DB`), metadata (id, size, created, expires, token hash) in SQLite.
- CORS follows `MIGA_ORIGINS` (same patterns as the WebSocket); the page's own origin is always allowed.
- The client IP is used only for the in-memory rate limit. Behind a proxy set `MIGA_TRUST_PROXY=1` to read
  `CF-Connecting-IP` / `X-Forwarded-For`. Blob ids and IPs are never logged.

Delete token: the sender gets `del` at upload and keeps it in its own copy of the message (it also reaches the
sender's other devices through sync). It is **not** put into the message to the recipient: a recipient may have
several devices, and one of them deleting the file after its own download would break the others. "Delete for
everyone" makes the sender call `DELETE`; otherwise the blob expires after 30 days.

### File encryption

Per file: a random 32-byte key `K` and a random 24-byte base nonce `N`. The plaintext is cut into chunks of
exactly 64 KiB (the last one is 0..64 KiB; an empty file is one empty chunk). Chunk `i` (counting from 0) is
sealed with XChaCha20-Poly1305 using key `K`, nonce `N` with the 64-bit big-endian counter `i` XORed into its
last 8 bytes, and AAD = one byte, `0x01` for the last chunk and `0x00` for every other chunk. The ciphertext is
the concatenation of the sealed chunks (each plaintext length + 16 bytes). Because the final-chunk flag is
authenticated, a truncated file cannot be opened. After decrypting, the receiver also checks
`SHA-256(plaintext) == hash` and the exact size before showing anything.

### Message payload

Inside the normal encrypted JSON (the relay sees none of it):

```json
{ "v": 0, "ts": 1700000000000,
  "text": "caption\n[photo \u2014 update MIGA to view]",
  "cap": "caption",
  "att": { "blob": "<32 hex>", "key": "<64 hex>", "nonce": "<48 hex>", "hash": "<64 hex>",
           "mime": "image/webp", "size": 123456, "w": 1600, "h": 900, "thumb": "data:image/webp;base64,..." } }
```

- `mime` is one of `image/jpeg|png|webp|gif`, `video/mp4|webm`. `size` is the plaintext size, at most 25 MiB.
  `thumb` is a blurred preview, 24 px wide, under 2 KB; it may be empty.
- Old-client fallback: v0.5.0 drops a message without a string `text`. So `text` carries the caption plus the
  line `[photo - update MIGA to view]` (or only the line when there is no caption). Clients that understand
  `att` read the caption from `cap` and ignore `text`, so they never show the placeholder.
- Own-device sync (`msg` and `history`) carries the same `att`, plus `del` for messages we sent. The other
  device fetches the blob with the same key.
- A message whose `att` is malformed is dropped.

### What the client does

Photos are decoded, scaled so the longest edge is at most 2048 px and re-encoded (WebP, else JPEG) through a
canvas, which **removes EXIF, GPS and other metadata**. Animated GIF, animated WebP, animated PNG, MP4 and WebM
are sent byte for byte so the animation survives. GIFs carry no EXIF; **MP4 and WebM can carry metadata
(creation time, GPS, device) and it is not stripped.** Received files are stored decrypted in the IndexedDB
`media` store, keyed by blob id, and removed when their message is deleted. There is no GIF search: it would
send IP addresses and search words to a third party.

## Safety numbers

Because an address is the account's Ed25519 public key, two people can check that nobody sits
between them by comparing one number derived from both keys. Nothing is sent for this.

**Derivation.** `lo` and `hi` are the two 32-byte account public keys (the addresses), sorted
bytewise (so both sides use the same order). `h = SHA-512("MIGA-safety-v1" || 0x00 || lo || hi)`.
For `i = 0..11`, group `i` is the 5-byte big-endian integer `h[5i..5i+4]` modulo 100000, written
with 5 digits (leading zeros kept). The 12 groups are the 60-digit number, shown as 12 groups of
5 digits (about 199 bits). Both sides get the same number.

**QR code.** `<origin>/app/#verify=<60 digits>`. Scanning compares it with the locally computed
number: equal marks the contact verified, different shows a warning and changes nothing.

**Verified state.** A contact record keeps `verified` = the 60 digits that were confirmed. It is
synced to linked devices inside the contact (`state.contacts`); a receiving device accepts it only
if it equals the number it computes itself. Linked devices share the account key, and a contact's
messages always come from its account key (device keys are used only between a user's own
devices), so one number per contact covers every device on both sides.

**Key changed.** A contact's address cannot change (a new key is a new contact). What can change
is the number: when this account's key is replaced (restore from a backup) a stored `verified`
no longer matches. The app then removes it, sets `keyChanged`, and shows a warning in that chat
until it is dismissed or the contact is verified again.

## What the relay can see

Sender address, recipient address, time, approximate size, and the IP addresses of both
sides. For attachments: the size and upload time of an opaque blob, and the IP that fetched it. It cannot read message content. Hiding this metadata is future work.
