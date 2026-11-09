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
4. Plaintext is JSON `{"v":0,"text":"...","ts":<unix ms>}`, padded with spaces to a multiple
   of 256 bytes (hides exact message length).
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
| client → relay | `{"t":"ping"}` → `{"t":"pong"}` | keep-alive (send at least every 60 s) |
| relay → client | `{"t":"error","err":"<code>","id":"<id>"}` | `bad_frame`, `too_large`, `rate_limited`, `queue_full` |

Rules enforced by the relay:

- `body` is at most 24 000 characters.
- A message stays stored until the recipient acknowledges it or 30 days pass.
- At most 1 000 undelivered messages are kept per recipient.
- At most 30 `send` frames per 10 seconds per connection.
- A connection that sends nothing for 90 seconds is closed.

Clients must de-duplicate deliveries by `(from, id)`: a message is re-sent on every
reconnect until it is acknowledged.

## What the relay can see

Sender address, recipient address, time, approximate size, and the IP addresses of both
sides. It cannot read message content. Hiding this metadata is future work.
