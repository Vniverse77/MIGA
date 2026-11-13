# Known bugs and small fixes

Open items to fix in a later release. Newest first.

## Open
- **App logo is dark on the dark background** (seen 2026-11-13, v0.5.0, desktop and Flatpak). The silhouette logo
  on the "Create your address" screen and in the app header is black on the near-black background, so it is
  barely visible. Fix: use a light version of the logo inside the app (the landing page already shows it light).
- **Flathub screenshots come from the web build** (v0.5.0). They show the web-only "Vniverse77 / Forum" header
  links. Replace them with screenshots of the desktop window in the next release.
- **Deleted messages can come back** through a later history sync from a linked device that was offline during
  the delete (no tombstones yet).
- **Delete contact / delete conversation do not sync** to linked devices.
- **No security audit yet.** MIGA is an MVP; an outside review is planned by the owner.
