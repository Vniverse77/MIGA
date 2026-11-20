<!--
DRAFT for lawyer review. Not legal advice. Prepared from the code and docs of MIGA (relay/, docs/PROTOCOL.md),
a check of the production server on 2026-11-20 and public secondary sources (owner's research note).
Legal review is pending.
Turkish version: PRIVACY.tr.md. Turkish KVKK notice: KVKK.tr.md. Rendered at /privacy; this comment is not shown.
-->
# MIGA Privacy Policy

Last updated: 2026-11-20

> **The short version**
> No accounts, no phone number, no e-mail, no ads, no analytics, and your data is never sold. The relay cannot read
> your messages. It does see your IP address while you are connected (in memory only, never written to a log), and it
> learns which address sends to which address, when, and how big the message is. MIGA is private, not anonymous.

## 1. Who runs MIGA

The relay server and the web app at miga.vniverse77.com are run by an individual developer who publishes under
the name Vniverse77. That person is the data controller (KVKK) and controller (GDPR) for this service.

- Operator (data controller): Vniverse77
- Address: Provided to authorities and to data subjects with a verified request via root@vniverse77.com
- Contact for privacy requests: root@vniverse77.com
- Representative in the EU or in Turkey, if one is required: None appointed

MIGA is free software (AGPL-3.0-or-later). Anyone can run their own relay; this policy covers only the relay
and web app operated by the person named above. The Turkish information notice under KVKK Art. 10 is on the
[KVKK page](/kvkk).

## 2. What MIGA does not collect

- No phone number, e-mail address, name or account. You do not sign up.
- No analytics, advertising, tracking cookies or third-party requests inside the app.
- No message content, no contact list, no profile name: these exist only on your devices and, as encrypted
  data, on the way between them. The relay holds no key that can open them.

Your identity is a key pair made on your device. Your "address" is the public key. If you lose the secret key
nobody, including us, can recover your account.

## 3. What is stored, where and for how long

| Data | Why | Where | How long |
|---|---|---|---|
| Recipient address, sender address, message id, send time and the encrypted message | To deliver a message to a recipient who is offline | Relay database (disk) in Istanbul | Until the recipient confirms receipt, you take the message back ("unsend"), or 30 days, whichever is first. At most 1000 queued messages per recipient |
| Encrypted attachment file, its size, creation and expiry time, and a hash of its delete token | To let the recipient download a file | Relay disk | Up to 30 days, or until deleted |
| Daily database backups | Recovery after a fault | Server disk | The last 7 are kept, so a deleted message can remain in a backup for up to 7 more days |
| Technical error messages of the relay | To fix faults | Server log file | Contain no message content and no client IP addresses; start-up and error lines only |

Deleted rows are removed from the database but their bytes may stay in free database pages until they are
overwritten. Nothing else is stored on the server about you: no user table, no sessions, no device list.

## 4. What is only processed in memory

| Data | Why | How long |
|---|---|---|
| Your IP address, while you are connected (taken from the header set by Cloudflare) | To run the connection and limit abuse: connection and message rate limits per IP | Held as counters in the relay's memory for a short window, dropped automatically. Not written to disk, not logged by the relay software, not in the database, not in backups |
| Short typing signals ("is typing") | To show typing | Forwarded live, never stored |

The relay software has no access log. The tunnel software on the server (Cloudflare Tunnel) logs only its own
connection events to Cloudflare, not visitors' addresses, and there is no other web server or proxy in between.

## 5. What is NOT anonymous

Please do not assume more privacy than MIGA gives:

- **Your IP address is visible** to Cloudflare while you use MIGA, and to the relay in memory (section 4). Your
  internet provider and network can see that you connect to miga.vniverse77.com. Use a VPN or Tor if that matters
  to you; MIGA does not hide it.
- **Metadata is visible to the relay:** which address sends to which address, when, and the size of the encrypted
  data. It cannot see the text, the name you chose to share, or who is behind an address.
- **Addresses are stable identifiers.** Anyone who knows your address can send messages to you. Use "block" in the app for unwanted senders.
- A person who gets hold of your unlocked device, or your secret key, can read your chats.
- Message size and timing can reveal patterns even though the text is encrypted.

## 6. Cloudflare and the hosting provider

Traffic to MIGA passes through Cloudflare (a content delivery and security service) before it reaches the relay
server in Istanbul. Cloudflare acts as a service provider (processor) for us: it terminates the TLS connection, so it
can see your IP address, connection times and the size of the traffic, and it applies its own logging and retention
under its own policy (https://www.cloudflare.com/privacypolicy/), which we do not control. The server host may
keep technical logs as well. We cannot promise that they keep nothing. None of them can read message content,
because it is encrypted on your device before it is sent.

## 7. Data on your device

Your key, contacts, chats, pictures and settings are stored on your device (browser storage or the app's data
folder). They are not uploaded. Clearing browser data, removing the app or using "Erase this device" deletes
them, and it cannot be undone. Linking another device sends an encrypted bundle through the relay under the
same 30-day maximum.

## 8. Why we process data, and the legal basis

We process the minimum above to deliver messages you ask to send and to keep the service available and free of
abuse. The legal bases are: performing the service you use, and our legitimate interest in the security and
stable operation of the service (GDPR Art. 6(1)(b) and (f); KVKK Art. 5(2)(c) and (f)).
<!-- pending legal review --> We do not sell data, profile users or use data for advertising.
If the law ever requires us to keep traffic logs, this policy will be changed before any logging starts.

## 9. Sharing and transfers

We do not give data to anyone except as listed here: Cloudflare and the server host, as technical service
providers; and authorities when the law requires it (section 11). The relay is in Istanbul, Turkey; Cloudflare
runs worldwide, so data in transit, including your IP address, can be processed in other countries. For Turkish
law this is a transfer abroad (KVKK Art. 9); see the [KVKK page](/kvkk). Messages are encrypted before they leave
your device.

## 10. Your rights

Where GDPR or Turkish KVKK (Law No. 6698) applies you may ask whether we process data about you, ask for access,
correction or deletion, object to processing, withdraw consent, and complain to your data protection authority (in
Turkey the Personal Data Protection Authority, https://www.kvkk.gov.tr). Because there are no accounts, we can only
find data when you tell us your address. We can then check whether messages for that address are queued and delete
them. We cannot give you message content, because we cannot read it. Write to the contact in section 1. It is free,
and we answer within 30 days.

## 11. Requests from authorities

If an authority sends a legal request, it must be in writing to the contact in section 1. We review it and
answer only what the law requires. What could exist: the sender and recipient addresses, times and ciphertext
of messages queued in the last 30 days, attachment sizes and expiry times. What does not exist and cannot be
handed over: message plaintext, contact lists, profile names, the identity behind an address, or past IP
addresses from the relay (it does not log them). Cloudflare and the host hold their own data and answer for it.
We do not add backdoors or weaken the encryption.

## 12. Children

MIGA is for people aged 16 and over. Do not use it if you are younger. If you believe a child is using it, write
to the contact above and we will delete queued data for the address you name.

## 13. Security and limits

Messages are encrypted on the device with modern, standard algorithms (see
[docs/PROTOCOL.md](https://github.com/Vniverse77/MIGA/blob/master/docs/PROTOCOL.md)). The relay and the web app
are open source, so you can check what they do. MIGA is in an early test phase and has not been security-audited.
Version 0 has no forward secrecy: if someone steals your secret key and has recorded your encrypted messages, they
could read them. In some countries messengers are blocked and using them can be punished. Do not rely on MIGA where
your safety depends on it. If there is a breach that puts you at risk, we will tell you and the authority as the law
requires. To report a security problem see [SECURITY.md](https://github.com/Vniverse77/MIGA/blob/master/SECURITY.md).

## 14. Changes

If this policy changes, the new version appears here with a new date. Older versions stay in the public source
history on GitHub.

Prepared by an independent developer; legal review in progress.
