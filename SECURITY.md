<!--
DRAFT for lawyer/owner review. Not legal advice. 
-->
# Security Policy

MIGA is an early-stage, not yet audited, end-to-end encrypted messenger. Please read the limits in
[docs/PROTOCOL.md](docs/PROTOCOL.md) (for example: no forward secrecy in protocol v0) before reporting them as bugs.

## Reporting a vulnerability

Please report privately. Do not open a public issue or post details before a fix is out.

1. Preferred: GitHub private vulnerability reporting. Open the repository's **Security** tab, then
   **Report a vulnerability**. 
2. Alternative: e-mail root@vniverse77.com. 

Please include: affected component (relay, web, desktop, Android), version, steps to reproduce, and impact. Do not
send real users' data. Do not test against other people's accounts or devices.

## What to expect

- Acknowledgement within 7 days (goal).
- An assessment and a plan within 30 days (goal).
- A fix and a public note (advisory and release notes) when it is safe. Credit if you wish.

MIGA is run by one person, so these are goals, not guarantees.

## Scope

In scope: the relay (`relay/`), the web client and apps (`web/`, `desktop/`), the protocol and cryptography
(`docs/PROTOCOL.md`), the build and packaging scripts, and the deployment files in `deploy/`.

Out of scope: denial of service by sheer traffic volume, findings that need a rooted or already compromised
device, social engineering, missing hardening on third-party services (Cloudflare, GitHub), and problems in
unmodified dependencies (report those upstream; tell us if MIGA is affected).

## Safe harbour

Good-faith research that follows this policy, avoids harming other users and does not read or keep other
people's data will not be pursued by the operator. This cannot bind third parties or authorities.
<!-- pending legal review -->

## Supported versions

Only the latest release and the current `master` branch receive fixes.
