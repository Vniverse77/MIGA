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

## What the relay can see

Sender address, recipient address, time, approximate size, and the IP addresses of both
sides. It cannot read message content. Hiding this metadata is future work.
