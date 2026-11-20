<!--
DRAFT for lawyer review. Not legal advice. Prepared from the code and docs of MIGA (relay/, docs/PROTOCOL.md)
and from public secondary sources (see the research note kept by the owner). Everything marked
[TO BE FILLED BY OWNER: ...] must be completed before publication. Turkish version: PRIVACY.tr.md.
Rendered at /privacy in the web app; this comment is not shown there.
-->
# MIGA Privacy Policy

Last updated: [TO BE FILLED BY OWNER: date]

MIGA is an end-to-end encrypted text messenger. It is not a social network. This page explains in plain
language what the service can see, what it stores and for how long, and what it cannot know.

## 1. Who runs MIGA

The relay server and the web app at miga.vniverse77.com are run by an individual developer who publishes under
the name Vniverse77.

- Operator (data controller): [TO BE FILLED BY OWNER: legal name]
- Address: [TO BE FILLED BY OWNER: postal address]
- Contact for privacy requests: [TO BE FILLED BY OWNER: e-mail address]
- Representative in the EU or in Turkey, if one is required: [TO BE FILLED BY OWNER: or "none"]

MIGA is free software (AGPL-3.0-or-later). Anyone can run their own relay; this policy covers only the relay
and web app operated by the person named above.

## 2. What MIGA does not collect

- No phone number, e-mail address, name or account. You do not sign up.
- No analytics, advertising, tracking or third-party requests inside the app.
- No message content, no contact list, no profile name: these exist only on your devices and, as encrypted
  data, on the way between them. The relay holds no key that can open them.

Your identity is a key pair made on your device. Your "address" is the public key. If you lose the secret key
nobody, including us, can recover your account.

## 3. What the relay processes

| Data | Why | How long |
|---|---|---|
| Recipient address, sender address, message id, send time, and the encrypted message | To deliver a message to a recipient who is offline | Until the recipient confirms receipt, you take the message back ("unsend"), or 30 days, whichever is first |
| Encrypted attachment file, its size, creation and expiry time, and a hash of its delete token | To let the recipient download a file | Up to 30 days, or until deleted |
| Your IP address, while you are connected | To run the connection and to limit abuse (connection and message rate limits) | Kept only in the relay's memory as counters, dropped automatically; not written to disk and not logged by the relay software |
| Short typing signals ("is typing") | To show typing | Forwarded live, never stored |
| Technical error messages of the relay | To fix faults | They contain no message content; rotated by the server |

The relay can therefore see which address sends to which address, when, and how large the encrypted data is.
It cannot see what the message says, who is behind an address, or the name you chose to share (that name
travels inside the encrypted message).

Backups: the server's database is backed up daily and the last 7 backups are kept, so a message that was
deleted can still sit in a backup for up to 7 more days. Backups are not readable without the server's access.

## 4. Cloudflare and the hosting provider

Traffic to MIGA passes through Cloudflare (a content delivery and security service) before it reaches the relay
server in Istanbul. Cloudflare terminates the TLS connection, so it can see your IP address, connection
times and the size of the traffic, and it applies its own logging and retention under its own policy
(https://www.cloudflare.com/privacypolicy/). The server host may keep technical logs as well. We do not control
those, and we cannot promise that they keep nothing. They cannot read message content, which is encrypted before
it leaves your device.

## 5. Data on your device

Your key, contacts, chats, pictures and settings are stored on your device (browser storage or the app's data
folder). They are not uploaded. Clearing browser data, removing the app or using "Erase this device" deletes
them, and it cannot be undone. Linking another device sends an encrypted bundle through the relay under the
same 30-day maximum.

## 6. Why we process data, and the legal basis

We process the minimum above to deliver messages you ask to send and to keep the service available and free of
abuse. The legal bases are: performing the service you use, and our legitimate interest in the security and
stable operation of the service (GDPR Art. 6(1)(b) and (f); KVKK Art. 5(2)(c) and (f)).
[TO BE FILLED BY LAWYER: confirm legal bases.] We do not sell data, profile users or use data for advertising.

## 7. Sharing and transfers

We do not give data to anyone except as listed here: Cloudflare and the server host, as technical service
providers; and authorities when the law requires it (section 9). The relay is in Istanbul, Turkey; Cloudflare
runs worldwide, so data in transit can pass through other countries. Messages are encrypted before they leave
your device.

## 8. Your rights

Where GDPR or Turkish KVKK (Law No. 6698) applies you may ask whether we process data about you, ask for access,
correction or deletion, object to processing, and complain to your data protection authority (in Turkey the
Personal Data Protection Authority, KVKK). Because there are no accounts, we can only find data when you tell us
your address. We can then check whether messages for that address are queued and delete them. We cannot give you
message content, because we cannot read it. Write to the contact in section 1.

## 9. Requests from authorities

If an authority sends a legal request, it must be in writing to the contact in section 1. We review it and
answer only what the law requires. What could exist: the sender and recipient addresses, times and ciphertext
of messages queued in the last 30 days, and attachment sizes and expiry times. What does not exist and cannot be
handed over: message plaintext, contact lists, profile names, the identity behind an address, or past IP
addresses from the relay. Cloudflare and the host hold their own data and answer for it.

## 10. Children

MIGA is for people aged 16 and over. Do not use it if you are younger. If you believe a child is using it, write
to the contact above and we will delete queued data for the address you name.

## 11. Security and limits

Messages are encrypted on the device with modern, standard algorithms (see
[docs/PROTOCOL.md](https://github.com/Vniverse77/MIGA/blob/master/docs/PROTOCOL.md)). MIGA is in an early test phase
and has not been security-audited. Version 0 has no forward secrecy: if someone steals your secret key and has
recorded your encrypted messages, they could read them. Do not rely on MIGA where your safety depends on it. If you
see a security problem, see [SECURITY.md](https://github.com/Vniverse77/MIGA/blob/master/SECURITY.md).

## 12. Changes

If this policy changes, the new version appears here with a new date. Older versions stay in the public source
history on GitHub.
