// Current release, used by the landing page and /download. scripts/release-build.sh rewrites these
// two constants on every version bump; every download link below is derived from them.
export const RELEASE_VERSION = '0.8.7';
export const RELEASE_DATE = '2026-11-20';

const REPO = 'https://github.com/Vniverse77/MIGA';
const BASE = `${REPO}/releases/download/v${RELEASE_VERSION}`;

export const FLATPAK_FILE = `MIGA_${RELEASE_VERSION}_x86_64.flatpak`;
export const URLS = {
	changelog: `${REPO}/releases/tag/v${RELEASE_VERSION}`,
	releases: `${REPO}/releases`,
	deb: `${BASE}/MIGA_${RELEASE_VERSION}_amd64.deb`,
	flatpak: `${BASE}/${FLATPAK_FILE}`,
	apk: `${BASE}/MIGA_${RELEASE_VERSION}-beta_android.apk`,
	sha: `${BASE}/sha256sums.txt`,
	aur: 'https://aur.archlinux.org/packages/miga-messenger'
};
export const YAY = 'yay -S miga-messenger';
export const FLATPAK_CMD = `flatpak install --user ./${FLATPAK_FILE}`;
