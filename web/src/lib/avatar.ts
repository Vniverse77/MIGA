// Default avatar: a tiny pixel person generated from the account address. The same address always
// gives the same picture on every device, which also helps to spot a look-alike address.
// Pure code, no network, no images shipped.
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';

const SKIN = ['#efcfb1', '#dcae82', '#b98457', '#8a5d3d', '#f4dcc6'];
const HAIR = ['#2b2a33', '#4a3426', '#8a5a2b', '#c9a24b', '#8e4a3a', '#5b6270', '#d8d2c4'];
const SHIRT = ['#3f7f9c', '#2f6f7a', '#4f6fa8', '#7a6fb0', '#c0794f', '#b8924a', '#5d8f6a', '#a95c6f'];
const PANTS = ['#2e3a4f', '#3b4a55', '#4a4358', '#554a3c'];
const BG = ['#16222d', '#162b2c', '#1d2335', '#2a2333', '#222b24', '#2b2a22', '#1f2a36', '#26212b'];
const EYE = '#16181d';

export const AVATAR_W = 10;
export const AVATAR_H = 12;

/** Rows of the left half (columns 0..4) of the 10x12 picture, mirrored to the right. */
type Half = string[];

// Letters: H hair, F face, E eye, S shirt, A arm (skin), P pants, . empty
const HAIR_STYLES: Half[] = [
	['..HHH', '.HHHH', '.HFFF'], // short
	['..HHH', '.HHHH', '.HHFF'], // fringe
	['.HHHH', 'HHHHH', 'HHFFF'], // big hair
	['..FFF', '.HHHH', '.HFFF'] // bald-ish top, side hair
];
const BODIES: Half[] = [
	['..SSS', '.SSSS', 'ASSSS', 'A.SSS'], // arms down
	['.SSSS', 'SSSSS', 'S.SSS', '..SSS'], // wide shirt
	['..SSS', 'ASSSS', 'ASSSS', '..SSS'] // arms out
];
const LEGS: Half[] = [
	['..PPP', '..PP.', '..PP.'],
	['.PPPP', '.PP..', '.PP..'],
	['..PPP', '..P..', '..PP.']
];

export type AvatarPixels = { rows: string[]; colors: Record<string, string>; bg: string };

const mirror = (half: string) => half + [...half].reverse().join('');

/** Deterministic picture for an address (case-insensitive). */
export function avatarPixels(address: string): AvatarPixels {
	const h = sha256(utf8ToBytes('miga-avatar-v1\0' + address.toLowerCase().trim()));
	const pick = <T>(list: T[], i: number) => list[h[i] % list.length];
	const hair = HAIR_STYLES[h[0] % HAIR_STYLES.length];
	const body = BODIES[h[1] % BODIES.length];
	const legs = LEGS[h[2] % LEGS.length];
	const eyes = h[3] % 2 ? '..FEF' : '.FEEF'; // wide-set or close
	const face = ['.FFFF', eyes, '.FFFF'];
	// Row layout (12 rows): top margin, 3 hair rows, 3 face rows, 4 body rows, legs.
	const half: Half = ['.....', ...hair, ...face, ...body, ...legs.slice(0, 1)];
	// Shorten to the picture height (12 rows); legs finish the figure.
	const rows = [...half, ...legs.slice(1)].slice(0, AVATAR_H).map(mirror);
	while (rows.length < AVATAR_H) rows.push('.'.repeat(AVATAR_W));
	const skin = pick(SKIN, 4);
	return {
		rows,
		colors: { H: pick(HAIR, 5), F: skin, A: skin, E: EYE, S: pick(SHIRT, 6), P: pick(PANTS, 7) },
		bg: pick(BG, 8)
	};
}

const cache = new Map<string, string>();

/** The avatar as an SVG string (crisp edges, background included). */
export function avatarSvg(address: string): string {
	const a = avatarPixels(address);
	let rects = '';
	a.rows.forEach((row, y) => {
		let x = 0;
		while (x < row.length) {
			const c = row[x];
			if (c === '.') {
				x++;
				continue;
			}
			let run = 1;
			while (row[x + run] === c) run++;
			rects += `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${a.colors[c]}"/>`;
			x += run;
		}
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${AVATAR_W} ${AVATAR_H}" shape-rendering="crispEdges"><rect width="${AVATAR_W}" height="${AVATAR_H}" fill="${a.bg}"/>${rects}</svg>`;
}

/** A data URL for an <img src>. */
export function avatarUrl(address: string): string {
	const key = address.toLowerCase().trim();
	let url = cache.get(key);
	if (!url) {
		url = 'data:image/svg+xml,' + encodeURIComponent(avatarSvg(key));
		if (cache.size > 500) cache.clear();
		cache.set(key, url);
	}
	return url;
}
