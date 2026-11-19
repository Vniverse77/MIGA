# Known bugs and small fixes

Open items to fix in a later release. Newest first.

## Open
- **Flathub screenshots come from the web build** (v0.5.0). They show the web-only "Vniverse77 / Forum" header
  links. Replace them with screenshots of the desktop window in the next release.
- **No security audit yet.** MIGA is an MVP; an outside review is planned by the owner.

## Fixed
- **Deleted messages can come back** through a later history sync from a linked device that was offline during
  the delete - fixed in v0.6.0 P9: deletes are kept as tombstones (90 days) and filter history, `msg` copies and
  re-deliveries.
- **Delete contact / delete conversation do not sync** to linked devices - fixed in P9 (tombstones sync as `tomb`).
- **New device got only the last 200 messages per chat** - fixed in P9: full resumable history transfer with progress.
- **Unread counters and read state were not shared between own devices**; an edit made while a device was offline
  could be missed by a later history copy - fixed in P9 (`read` sync, merge by `edited` time).
- **App logo is dark on the dark background** (v0.5.0) - fixed in v0.6.0 P1: the logo is an inline SVG that follows the theme colour.
