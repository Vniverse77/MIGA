/** Finds web links in message text. Only http and https are ever linked; nothing is fetched or previewed. */
export type LinkPart = { t: string; url?: string };

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export function linkify(text: string): LinkPart[] {
	const out: LinkPart[] = [];
	let at = 0;
	for (const m of text.matchAll(URL_RE)) {
		let raw = m[0];
		// Closing punctuation belongs to the sentence; a ")" stays only when the address opened one.
		while (raw) {
			const last = raw.at(-1) as string;
			const count = (ch: string) => raw.split(ch).length - 1;
			if ('.,;:!?»'.includes(last) || (last === ')' && count('(') < count(')'))) raw = raw.slice(0, -1);
			else break;
		}
		let url: string | undefined;
		try {
			const parsed = new URL(raw);
			if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed.href;
		} catch {
			// Not a valid address: stays plain text.
		}
		const start = m.index ?? 0;
		if (!url) continue;
		if (start > at) out.push({ t: text.slice(at, start) });
		out.push({ t: raw, url });
		at = start + raw.length;
	}
	if (at < text.length) out.push({ t: text.slice(at) });
	return out.length ? out : [{ t: text }];
}
