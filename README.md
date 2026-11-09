# MIGA — Make Internet Great Again

An experimental end-to-end encrypted messenger meant to keep people connected across
restricted networks, starting with Turkmenistan.

**Status: early test phase. Not security-audited. Do not rely on it where your safety
depends on it.**

## How it works

- Your identity is a key pair generated in your browser. No phone number, e-mail or account.
- Messages are encrypted on the device (X25519 + XChaCha20-Poly1305).
- A small relay forwards the sealed messages and keeps them for offline recipients. It cannot
  read them. Anyone can run a relay.
- All traffic is WebSocket over TLS on port 443, so it looks like ordinary HTTPS.

Details: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Layout

| Path | What |
|---|---|
| `relay/` | Go relay server (WebSocket + SQLite). Can also serve the built web app. |
| `web/` | SvelteKit web client and landing page, built to static files. |
| `docs/` | Protocol description. |

## Development

Requirements: Go 1.23+, Node.js 22+ with npm (Deno also works for the web part).

```sh
# 1. relay on 127.0.0.1:8787
cd relay && go mod tidy && go run .

# 2. web client on http://localhost:5173 (proxies /ws to the relay)
cd web && npm install && npm run dev
```

Open the app in two different browsers (or one normal and one private window), copy the
address from one into the other, and send a message.

## Production build

```sh
cd web && npm run build            # writes web/build
cd relay && go build -o miga-relay .
MIGA_STATIC=../web/build MIGA_DB=/var/lib/miga/miga.db ./miga-relay
```

Relay settings (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `MIGA_ADDR` | `127.0.0.1:8787` | listen address |
| `MIGA_DB` | `miga.db` | SQLite file for undelivered messages |
| `MIGA_STATIC` | empty | directory of the built web app to serve; empty serves only `/ws` |
| `MIGA_ORIGINS` | empty | extra allowed WebSocket origins, comma-separated (same-origin is always allowed) |

## Roadmap

1. Text messaging in the browser (this stage).
2. Linux packages (AUR, deb), then Windows and Android, from the same UI via Tauri.
3. Censorship resistance: multiple relays, fallback domains, direct peer-to-peer links
   where the network allows, obfuscated transports in the native apps.
4. Forward secrecy (ratchet), then voice calls.
