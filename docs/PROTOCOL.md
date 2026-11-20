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
| client → relay | `{"t":"send","to":"<addr>","eph":true,"body":"<base64>"}` | ephemeral frame (live typing): no `id`, no `sent` reply, never stored; see [Live typing](#live-typing) |
| relay → client | `{"t":"msg","from":"<addr>","eph":true,"body":"<base64>","ts":<unix ms>}` | ephemeral delivery; do not acknowledge |
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
- Ephemeral frames (`eph: true`) have their own budget of 10 per second per connection; frames over
  it are dropped silently. They do not count against the `send` limit above.
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
   bundle. The sponsor answers with the profile, contacts, device list, block and mute lists; the new
   device then pulls the full history from it ("Full history transfer" below).

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
| `history` | `chats`: a piece of message history (the old, push-style snapshot; still accepted, but filtered through tombstones; no longer sent). |
| `hxq` | New device to another device: `sid`, `q`, `after`. Asks for the next page of history after the cursor `after` (null = from the start). |
| `hx` | The answer: `sid`, `q`, `chats` (one page), `next` (cursor for the next request, null = that was the last page), `total` (messages the sender holds). |
| `tomb` | `items`: remembered deletes ("Tombstones" below), at most 100 per message. |
| `read` | `peer`, `upTo` (ms): this chat is read up to its newest incoming message with `ts <= upTo` on the sending device. |
| `msg` | A copy of one message just sent or received: `peer`, `message`, optional `name`. |
| `del` | Old form of a message delete (`peer`, `items`). Still accepted and treated as a message tombstone; current clients send `tomb` instead. |
| `edit` | `peer`, `id`, `mine`, `text`, `ts`: an edit one device already applied (own edit, or one received from the peer), so the others show the same text. |
| `st` | `peer`, `ids`, `d` (`delivered` or `read`): a receipt one device already applied, so the others show the same ticks. `read` is applied only if read receipts are on. |
| `receipts` | `on`: the account-wide read receipts setting. |
| `state.pins` | `pins` = `{m: {<chat>: [<key>...]}, c: [<chat>...]}`: pinned messages (key = `m`/`t` + id, newest first, at most 3 per chat) and pinned chats (top first, at most 5). The complete set; it replaces the receiver's. Pins are local to the account's devices and are never sent to the other person. |
| `bye` | `address` of a device that left or was removed. The named device erases itself. |

The relay pushes a message for the account address to every device online at that moment and
deletes it on the first acknowledgement; the receiving device forwards a `msg` copy so
devices that were offline get it too. Clients de-duplicate by message id.

### Full history transfer

The old snapshot pushed at most the newest 200 messages per chat in at most 40 pages, from an
in-memory queue that was lost if the sponsor's tab closed. Now the new device **pulls** the history
(stop-and-wait, one request open at a time), so the sponsor keeps no state and either side can stop
and resume.

1. After linking, the new device stores a job `{sid, from, cursor, done, total}` (IndexedDB `meta`,
   key `hx`) and sends `hxq` to the sponsor with `after = null`.
2. Canonical order: chat address (ascending), then message `ts`, then `id`. A cursor is
   `{c, t, i}` (chat, ts, id) and means "everything strictly after this message".
3. The answering device builds one page of up to about 12 000 bytes of message JSON (so the sealed
   body stays well under the relay's 24 000 character body limit and 32 KiB frame limit), answers with
   `hx` (`next` = cursor of the last message of the page, or null at the end, plus `total`). The
   answers are paced by the 400 ms sync outbox, so a copy stays under the relay's 30 sends per
   10 seconds (about 2.5 pages per second).
4. The new device accepts only the answer to its open request (`q` matches), merges the page
   (idempotent: a message that is already there is not duplicated), stores the new cursor and
   `done`, then asks for the next page. The job is deleted when `next` is null.
5. Everything on a message travels: `delivery` (delivered/read), `edited`, `reply`, and `att` with
   the blob id, file key, nonce, hash and (for own messages) the blob delete token, so the new
   device can fetch the media from the relay while the blob still exists (30 days). Media files
   themselves are not re-sent over the sync channel. Messages that arrive as history are marked
   seen (no read receipts, no unread counts, no notifications). Contacts (with `verified`, which
   is only kept if it matches the safety number the new device computes itself), the block list,
   muted chats and the read-receipts setting are sent as `state`/`receipts` right after `hello`.
6. Resume: after a restart the job is read back and the request repeats from the saved cursor. If no
   answer comes for 20 seconds the request is repeated; after three silent tries the next device of
   the account is asked. A stale answer is ignored.
7. The first request (`after = null`) also makes the answering device send its tombstones, before the
   first page.
8. UI: a banner "Copying history N%" with a progress bar (`N` = `done / total`, never 100 before the
   last page); it shows 100% for a few seconds at the end. Settings, Devices has a button per device
   to copy the history from it again; the merge is the same, so it can only add or update.

**Merge rule.** A message that is already present is not replaced, except: the one with the larger
`edited` time supplies the text (last writer wins), and `delivery` only moves forward
(delivered, read). So an edit made while a device was offline reaches it by `edit` (the relay keeps the
message for it) or, if that was missed, by any later history copy.

### Tombstones

A delete is remembered so a device that was offline, or a later history copy, cannot bring the item back.
A tombstone is `{c, s, id?, mine?, ts}`: `c` = chat (peer address); `s` = `m` (one message: `id`,
`mine`), `c` (the conversation: every message with `ts <=` the tombstone's `ts`) or `k` (the contact and
its conversation, same rule); `ts` = when it was deleted. They are kept in IndexedDB `meta` key `tombs`.

- Created by: delete for me, delete for everyone, a delete request received from the peer, delete
  conversation, delete contact. Each is sent to the other devices as `tomb`.
- Applied on arrival: a tombstone removes matching messages, the conversation and (`k`) the contact.
  Incoming messages, `msg` copies and history pages that match a tombstone are dropped (a relay
  re-delivery of a deleted message is acknowledged and dropped).
- A message newer than a `c`/`k` tombstone is not covered. A `k` tombstone is removed when the contact is
  added again, or when a message or contact update newer than it arrives (the sync message's relay time
  is compared, so an old queued rename cannot bring a deleted contact back).
- A `c`/`k` tombstone replaces older message tombstones of that chat; at most 5000 are kept.
- Pruned after 90 days. A device that was offline for longer than that can bring old items back and
  should be re-linked.

### Read state between devices

When a chat is read on one device (opened on screen, or a message arrived while it was open), that
device sends `read` with `upTo` = `ts` of the newest incoming message. The others lower that chat's
unread counter to the number of incoming messages newer than `upTo` (0 clears it, removes the
notification) and mark the older ones seen, so they do not send a second read receipt.

**Limits to know.** Removing a device is cooperative: it erases itself the next time it
connects, but it did hold the account key. If a device is lost, the only real fix is a new
address. The relay can see that the account address and its device addresses connect from
the same IP and exchange messages, so it can tell which devices belong together.

## Deleting messages and blocking

- **Delete for me** removes a message on this device and, through a `tomb` tombstone, on the linked devices.
  The other person keeps their copy.
- **Delete for everyone** (own messages only) sends the delete request above, sends `unsend`
  to the relay, and removes the message locally and on linked devices. It needs a relay
  connection; offline, nothing is deleted. If the recipient is offline, `unsend` removes the
  queued copy so it is never delivered; if the relay is an older one, the request still
  arrives later and does the job.
- **Block** is local state, synced between linked devices as `blocked`. Messages from a blocked
  address are acknowledged (so the relay deletes them) and dropped unread. The sender is not
  told. A deleted contact stays blocked until unblocked. Delete conversation and delete contact are
  also synced to the linked devices as tombstones (they do not affect the other person).

Honest limits: deletion is a request, not a guarantee. The recipient may have read the message
already, may have a copy or screenshot, and a modified client can ignore the request. Clients
that predate the request silently ignore it, so the message stays on their side. Tombstones stop a linked
device that was offline from bringing a deleted message back, for 90 days (see "Tombstones"). The relay's stored copy of an unsent message is deleted, but the relay can still
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

## Typing indicator and live typing

Setting "Typing" (per device): **Off**, **Typing indicator** (default) or **Live text**. An older
"Show what I type live" setting migrates to Live text when it was on, otherwise to the indicator.

**Typing indicator.** While the composer has focus, the box is not empty and the chat is open (not a
request, not blocked), the sender transmits `{"v":0,"ts":<ms>,"typing":true}` as an ephemeral frame,
repeated at most every 3 s while the draft changes, and `{"typing":false}` when the box empties, on
blur, on chat switch or when the app is hidden. No text, so old clients (which find no known key)
drop it. The receiver shows "typing..." in the chat header and as a small row at the end of the
chat, and in the chat list, and forgets it after 6 s without a frame. The relay forwards ephemeral
frames concurrently, so receivers drop a frame whose `ts` is older than the newest one seen from
that sender. Live text frames also mark the sender as typing.

**Live text** (the rest of this section). While it is on, the
composer has focus and the chat is open, the sender transmits what is in the message box:

- `{"v":0,"ts":<ms>,"live":{"text":"<current draft>"}}`, at most 4000 characters, throttled to
  one frame per ~300 ms (trailing edge). `{"live":{"text":""}}` is sent when the draft is empty
  (sent, cleared), on blur, on chat switch, when the app is hidden and when the setting is turned off.
- There is no top-level `text`, so v0.5.0 clients drop it like any other control message.
- It travels as an **ephemeral frame**: `{"t":"send","to":"<addr>","eph":true,"body":"..."}`.
  The relay cannot read the payload, so the flag is on the outer frame. The relay forwards it
  as `{"t":"msg","from":...,"eph":true,...}` only to devices of the recipient that are connected
  at that moment; otherwise it is dropped. It is never written to the queue or the database, never
  gets a `sent` reply or an error, and is limited to 10 per second per connection (separate from
  the `send` limit).
- Receiver: shows one dim, italic "typing live" line under the messages of that chat, updated in
  place. It is cleared by an empty live text, by the real message from that sender, when the chat
  is closed, or after 5 seconds without updates. It is never a bubble, never unread, never a
  notification, never acknowledged, never stored and never synced to the receiver's other devices.
  Live frames from blocked contacts are ignored. Receiving does not depend on the receiver's own
  setting: the sender decides whether to send.
- Old relays: a relay without `eph` support rejects the id-less `send` with `bad_frame` (nothing is
  queued); the client then stops sending live text until it reconnects. Such a relay still counts
  the rejected frames against its `send` limit, so update the relay before using the feature.
  A live payload that reaches a client as a normal queued message is dropped.

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
  `400` empty body, `429` more than 30 uploads per 10 minutes (or more than 2 at once) from one IP, `503` more than 16 uploads at once on the whole relay (`MIGA_BLOB_UPLOADS_TOTAL`),
  `507` the storage quota is used up.
- Limits: 25 MiB of content plus the per-chunk tags (about 25.1 MiB on the wire), 30 days TTL (hourly
  cleanup), total quota `MIGA_BLOB_QUOTA` (default 1 GiB). Files live in `MIGA_BLOBS` (default `blobs/`
  next to `MIGA_DB`), metadata (id, size, created, expires, token hash) in SQLite.
- CORS follows `MIGA_ORIGINS` (same patterns as the WebSocket); the page's own origin is always allowed.
- The client IP is used only for the in-memory rate limit. Behind a proxy set `MIGA_TRUST_PROXY=1` to read
  `CF-Connecting-IP` only; without it per-IP limits are skipped, never shared. Blob ids and IPs are never logged.

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

## Link previews

Like Signal, the **sender's** device makes the preview; the receiver never contacts the website. A text message
may carry `"prev": {"url", "title", "desc", "site", "img"}` next to `text`, inside the same ciphertext:

- `url` is a link that appears in `text` (a card for a link the text does not show is dropped), http or https only.
  Caps: url 2048, title 200, desc 300, site 80 characters; control and bidi characters are removed.
- `img` (optional) is an ordinary attachment (see above): a still WebP/JPEG/PNG, at most 512 px and 300 KB,
  encrypted and uploaded once. The delete token is not sent.
- Old clients ignore `prev` and show the text with the link. Messages with an attachment carry no `prev`.

Fetching is done only by the desktop and Android apps (Rust commands `fetch_preview` and `fetch_preview_image`
in `desktop/src-tauri/src/preview.rs`): http/https only, at most 3 redirects, 5 s total, HTML read up to 512 KB,
images up to 300 KB, no cookies, generic User-Agent. An SSRF guard inside DNS resolution refuses loopback,
private (10/8, 172.16/12, 192.168/16), link-local, 100.64/10, unique-local (fc00::/7), fe80::/10, multicast and
other non-public addresses on every hop, for IP-literal hosts too; the checked address is the one connected to.
The picture is shrunk and re-encoded in the page, which drops all metadata. The browser build never fetches
(CORS, and it would expose the visitor's IP to arbitrary sites). Settings > Privacy > "Link previews" (on by
default in the apps) turns it off; the website sees the sender's IP address when a preview is made.

## Message requests and first contact

Client-side only. The relay is unchanged and learns nothing new: the proof of work below is inside the ciphertext.

**Requests.** A message from an address that is not a contact (never added, never written to, not accepted) is not a chat. It is stored as a *request* and shown in a separate Requests inbox with the sender's short address, its safety number and a preview. The receiver can accept (it becomes a normal chat), delete (the request and its messages are removed; writing again makes a new request) or block (the address is added to the block list). Until accepted the receiver sends nothing back: no `ack` (delivered), no `seen`, no live typing, no profile name, and notifications show only "New message request". The relay-level `ack` is still sent, since the relay needs it to free its queue. On accept the receiver sends the delayed `ack` for the stored messages. A contact the user adds, or writes to, is never a request, and neither is an existing contact.

**Proof of work.** A sender writing to an address that has not yet written to it attaches `"pow":{"v":1,"d":<UTC day = ms / 86 400 000>,"n":<nonce>}` to the plaintext. Valid when `SHA-256("miga-pow-v1:" + sender + ":" + recipient + ":" + d + ":" + n)` has at least 17 leading zero bits and `d` is within one day of the relay timestamp of the message. One solution serves one recipient for one day, so a sender solves once per recipient per day (about 2^17 hashes: roughly 0.2 to 0.5 s on a desktop, 1 to 3 s on a mid phone, in a Web Worker). Clients stop attaching it once the peer has written back.

**Receiver rules for an unknown sender.**

| Message | Result |
|---|---|
| valid `pow` | request, "Checked" |
| no `pow` (older clients) | request, "Unverified" badge (not dropped in this release) |
| `pow` present but wrong, or no `pow` while the optional "Hide unverified requests" setting is on | acknowledged to the relay, discarded, counted as "N filtered" |

Clients that predate this field ignore `pow`. Linked devices: the `msg` sync copy carries `"req":true` for a request, and a new `accept` sync kind (`{"k":"accept","peer":addr}`) moves the chat out of Requests on the other devices; delete and block already sync through tombstones and the block list. The `state` contact record keeps `request`/`unverified`.

Limits: this is a speed bump, not identity proof. A sender that omits `pow` still reaches Requests unless the receiver turns on the strict setting; a later release can make that the default.

## Groups (v1)

Small private groups, at most 5 members including the admin. Client-side only: the relay is unchanged and does
not know groups exist. A group message is encrypted separately to every member with the normal pairwise envelope
(see "Encryption") and sent as an ordinary relay message to that member. There is no shared group key, so removing
a member needs no re-keying: they simply stop receiving.

**Group id and state.** `gid` = 16 random bytes, 32 hex. The state is
`{"id":gid,"name":<=40 chars,"admin":<address>,"members":[<address>...],"banned":[<address>...],"epoch":<int>,"createdAt":<ms>}`.
Invariants (a state that breaks one is ignored): 1 to 5 distinct valid addresses in `members`, the admin is one of them,
`banned` (at most 50) shares no address with `members`, `epoch >= 1`. Only the admin changes the state; every change
raises `epoch` by at least 1.

**Signature.** `sig` = hex Ed25519 signature, made with the admin's identity key, over the bytes
`"miga-group-v1" 0x00 canonical`, where `canonical` is the JSON of the state with keys in the order above, `members` and
`banned` sorted bytewise, no whitespace. The admin address is the Ed25519 public key, so anyone can verify it.

**Payloads.** All group payloads are the pairwise plaintext with **no top-level `text`**: `{"v":0,"ts":..,"group":{..}}`
(control) or `{"v":0,"ts":..,"g":{..}}` (content). Both stay inside the ciphertext.

Admin-signed control, `group` = `{"op":<op>,"st":<state>,"sig":<hex>}` (an invite to a stranger also carries the usual top-level `"pow"`),
sent by the admin to every member of the new state and, for `remove`/`ban`, to the removed address too. `op` is a hint
for display (`invite` | `remove` | `ban` | `rename` | `transfer`); receivers act on the state, not on `op`.
Unsigned member control, `group` = `{"op":"accept"|"leave"|"want","gid":..,"epoch":n}`: `accept` is sent to the admin
and all members, `leave` the same, `want` only to the admin ("I saw epoch n, send me the state").

Content, `g` = `{"gid":..,"epoch":<sender's known epoch>,"id":<message id, 32 hex>,"t":<kind>,...}`:

| `t` | Fields |
|---|---|
| `msg` | `text` (<= 4000), optional `att` (as in "Attachments", without `del`), `reply`, `mentions` (member addresses, <= 5), `name` (sender's shared display name) |
| `edit` | `eid` (the message), `text` |
| `del` | `ids` (<= 50) |
| `typing` | `on` (bool): ephemeral frame |
| `live` | `text`: ephemeral frame |

**Receiver rules (state).** A signed state is accepted only if (1) it is well formed and has the invariants above, (2)
the signature verifies against the admin of the state I already know (for an unknown group: against `st.admin`, which must
also be the sender of the envelope), (3) `st.epoch` is greater than the epoch I know. Otherwise it is dropped silently
(still acknowledged to the relay). If I am in `members` the group is mine (first time: an *invite*, status `invited`); if I
am not, my status becomes `removed` (or `banned` when listed in `banned`) and the record is kept so an older invite
cannot be replayed. A new state replaces the old one; `accept` marks and `leave` hints that came from members that are no
longer listed are forgotten.

**Receiver rules (content).** Dropped (acknowledged, no trace) when the group is unknown, my status is not `active` or
`invited`, the sender is not in `members` of my known state, is in `banned`, is me, or has sent `leave`. Duplicates are
dropped by `(gid, id)`, so a relay redelivery, a linked-device copy and a retry never show twice. `edit` and `del` only
touch a message whose author is the sender (delete for everyone is author-only). A message whose `epoch` is higher than
mine makes the client send `want` to the admin once per epoch (the admin answers with `op:"update"` and the current
state). Messages that arrive while *I* have not accepted yet are stored, shown after accept and never notify. A deleted
message id is remembered (300 per group) so a late copy cannot bring it back.

**Flows.**
- *Create*: admin makes a state (epoch 1), sends it to each invitee. Invitees are members at once but are `invited`
  until they accept.
- *Accept*: the invitee sets status `active`, sends `accept` to the admin and every other member. Receivers record it.
  Until accepted a client sends nothing into the group (no messages, typing, receipts).
- *Invite* (later): admin adds the address (refused when banned or when 5 are reached), raises the epoch, sends the new
  state to all members including the new one.
- *Leave*: a member sends `leave` to all and drops the group locally. The admin removes it from `members`, raises the
  epoch and sends the new state to the remaining members and to the leaver. The admin cannot leave while others remain
  (transfer first).
- *Remove / ban*: admin removes the address (ban also adds it to `banned`), raises the epoch, sends the state to the
  remaining members and to the removed one. Nobody sends to a removed member any more, and their later messages and
  `accept`s are dropped (the admin never re-adds a banned address).
- *Rename*: state change. *Transfer admin*: the old admin signs a state whose `admin` is another member.

**Fan-out.** Sender encrypts the payload for every member except itself, with one relay id per recipient
(`hex(SHA-256(gid ":" id ":" recipient))` first 32 chars), so the relay's `sent` frame says which copy arrived. Each copy is retried like a
normal message (see outbox: 2 s, 5 s, 15 s, 30 s, then every 60 s, 24 h limit). Own other devices get a sync copy
(`grp` = the group record, `gmsg` = one group message, `gdel`, `gedit`; unknown kinds, which old devices ignore) and also receive group
messages from the relay like any message sent to the account. Typing and live frames go as ephemeral frames to members
only, never queued.

**Attachments.** The file is encrypted and uploaded once. The same `att` (blob id, key, nonce, hash) is put into each
member's envelope; the delete token stays with the sender. "Delete for everyone" deletes the blob.

**Mentions.** `mentions` lists members. A client exposes `mentionsMe` on the stored message so a muted group can still
notify for it.

**Requests.** An invite from an address that is not a contact is a request until accepted, classified like a first
message (proof of work in the top-level `pow`, same rules and "unverified" badge; a wrong proof is dropped and counted as
filtered). The sender attaches `pow` to an invite when the invitee has never written to it.

**Transfer.** The old admin signs the state that names the new admin (receivers verify against the admin they know); the new admin signs every later state. A client stores which address made the signature it holds (`signer`).

**Old clients.** Payloads have no top-level `text` and none of the keys older clients know, so they fail to read them,
acknowledge and discard them: no bubble, no error (the same path as `typing`). Their owner just does not see the group
and cannot be invited meaningfully. Checked by a test that runs a copy of the v0.9.4 reader over real group payloads (it
returns nothing for them).

Limits: members see each other's addresses. The admin is trusted for membership; a malicious member can only send
messages like a normal contact. No forward secrecy (same as v0). Delivery to members is per copy; there are no group
read receipts in v1.

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
sides. For attachments: the size and upload time of an opaque blob, and the IP that fetched it. Live typing frames add timing only: the relay sees that an ephemeral frame passed, not its content, and keeps nothing. It cannot read message content. Hiding this metadata is future work.
