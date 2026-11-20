// Link previews, the pure part: finding the link, reading Open Graph tags, validating a preview that
// arrives from the network. Nothing here touches the network or the platform.
//
// Privacy design (like Signal): the SENDER's device fetches the page while typing (see previewfetch.ts) and puts
// the result inside the end-to-end encrypted message. Receivers never contact the website.
import { cleanAtt, type Att } from './attach';
import { linkify } from './links';

/** Length caps. They apply to what we send and to everything we accept. */
export const PREVIEW_CAPS = { url: 2048, title: 200, desc: 300, site: 80 } as const;

/** What travels in the message (`prev`). `img` is an ordinary encrypted attachment (WebP, at most 512 px). */
export type Preview = { url: string; title: string; desc: string; site: string; img?: Att };

/** The first web link in a text, or null. */
export function firstLink(text: string): string | null {
	for (const part of linkify(text)) if (part.url && part.url.length <= PREVIEW_CAPS.url) return part.url;
	return null;
}

const clip = (v: unknown, max: number): string =>
	typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/**
 * Validates a preview from the network, storage or another device. The preview must be about a link that is
 * really in the message text; otherwise a card could advertise one address while the text shows another.
 * Null when it is malformed or empty (the message is then shown without a card).
 */
export function cleanPreview(value: unknown, text: string, withDelete = false): Preview | null {
	if (!value || typeof value !== 'object') return null;
	const p = value as Partial<Preview>;
	if (typeof p.url !== 'string' || p.url.length > PREVIEW_CAPS.url) return null;
	let url: string;
	try {
		const parsed = new URL(p.url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		url = parsed.href;
	} catch {
		return null;
	}
	if (!linkify(text).some((part) => part.url === url)) return null;
	const title = clip(p.title, PREVIEW_CAPS.title);
	const desc = clip(p.desc, PREVIEW_CAPS.desc);
	const site = clip(p.site, PREVIEW_CAPS.site);
	const img = p.img === undefined ? null : cleanAtt(p.img, withDelete);
	// An image that is not a small still picture is dropped, the card stays.
	const okImg = img && /^image\/(webp|jpeg|png)$/.test(img.mime) && img.size <= 300_000 && img.w <= 1024 && img.h <= 1024 ? img : null;
	if (!title && !desc) return null;
	return { url, title, desc, site, ...(okImg ? { img: okImg } : {}) };
}

// ── Open Graph reading ──────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
		if (e[0] === '#') {
			const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
		}
		return ENTITIES[e.toLowerCase()] ?? all;
	});
}

function attrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
		const name = m[1].toLowerCase();
		if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
	}
	return out;
}

export type PageMeta = { title: string; desc: string; site: string; image: string };

/**
 * Reads title, description, site name and image address from page HTML: Open Graph first, then Twitter
 * card, then <title> and <meta name="description">. `pageUrl` resolves relative image addresses; only
 * http and https image addresses are returned.
 */
export function parseMeta(html: string, pageUrl: string): PageMeta {
	const head = html.slice(0, 512 * 1024).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '');
	const meta = new Map<string, string>();
	for (const m of head.matchAll(/<meta\b([^>]*)>/gi)) {
		const a = attrs(m[1]);
		const key = (a.property ?? a.name ?? '').toLowerCase();
		if (key && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
	}
	const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
	const first = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v && v.trim()) ?? '';
	let image = '';
	const rawImage = first('og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src').trim();
	if (rawImage) {
		try {
			const u = new URL(rawImage, pageUrl);
			if (u.protocol === 'http:' || u.protocol === 'https:') image = u.href;
		} catch {
			// No usable image.
		}
	}
	let host = '';
	try {
		host = new URL(pageUrl).hostname.replace(/^www\./, '');
	} catch {
		// Stays empty.
	}
	return {
		title: clip(first('og:title', 'twitter:title') || (titleTag ? decodeEntities(titleTag[1]) : ''), PREVIEW_CAPS.title),
		desc: clip(first('og:description', 'twitter:description', 'description'), PREVIEW_CAPS.desc),
		site: clip(first('og:site_name') || host, PREVIEW_CAPS.site),
		image: image.length <= PREVIEW_CAPS.url ? image : ''
	};
}
