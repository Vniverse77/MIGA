// Local search over decrypted messages. Pure functions, no network, no storage.
//
// Why in memory and not an IndexedDB cursor: every message is already decrypted and held in the
// `chats` state, so scanning it costs no extra reads or structured clones. ~10k messages is a
// few milliseconds of string.indexOf over a cached, normalised copy of each text.
//
// Matching is case-, accent- and diacritic-insensitive: lower-case, NFD, strip combining marks,
// and a small map for letters that have no decomposition (dotless i, ß, ø, đ, ł ...). So
// "sicak" finds "sıcak" and "gorusuruz" finds "görüşürüz" (ä ň ý ž ç ş ğ ö ü fold the same way).

import type { Message } from './storage';

const EXTRA: Record<string, string> = { 'ı': 'i', 'ß': 'ss', 'ø': 'o', 'đ': 'd', 'ł': 'l', 'æ': 'ae', 'œ': 'oe', 'ð': 'd', 'þ': 'th' };
const MARKS = /\p{M}/gu;

/** Folds one character (code point) to its search form; may be empty (a lone mark) or longer. */
function foldChar(ch: string): string {
	const lower = ch.toLowerCase();
	let out = '';
	for (const c of lower.normalize('NFD').replace(MARKS, '')) out += EXTRA[c] ?? c;
	return out;
}

/** Folds a whole string. ASCII-only strings take the fast path. */
export function fold(text: string): string {
	// eslint-disable-next-line no-control-regex
	if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase();
	let out = '';
	for (const ch of text) out += foldChar(ch);
	return out;
}

/** Folded text of a message, cached per message object and text. */
const cache = new WeakMap<object, { text: string; folded: string }>();
export function foldedText(m: Message): string {
	const hit = cache.get(m);
	if (hit && hit.text === m.text) return hit.folded;
	const folded = fold(m.text);
	cache.set(m, { text: m.text, folded });
	return folded;
}

export const messageKey = (m: Pick<Message, 'mine' | 'id'>): string => (m.mine ? 'm' : 't') + m.id;

/** Query folded and trimmed; empty means "no search". */
export const foldQuery = (q: string): string => fold(q.trim().replace(/\s+/g, ' '));

/** Messages whose text (or attachment caption) contains the query, in list order. */
export function searchMessages(list: readonly Message[], query: string): Message[] {
	const q = foldQuery(query);
	if (!q) return [];
	const out: Message[] = [];
	for (const m of list) if (m.text && foldedText(m).includes(q)) out.push(m);
	return out;
}

/** Match ranges in the ORIGINAL text, found through a folded copy with an index map. */
export function matchRanges(text: string, query: string): [number, number][] {
	const q = foldQuery(query);
	if (!q || !text) return [];
	let folded = '';
	const starts: number[] = [];
	const ends: number[] = [];
	let pos = 0;
	for (const ch of text) {
		const f = foldChar(ch);
		for (let k = 0; k < f.length; k++) {
			starts.push(pos);
			ends.push(pos + ch.length);
		}
		folded += f;
		pos += ch.length;
	}
	const ranges: [number, number][] = [];
	let from = 0;
	for (;;) {
		const at = folded.indexOf(q, from);
		if (at < 0) break;
		ranges.push([starts[at], ends[at + q.length - 1]]);
		from = at + q.length;
	}
	return ranges;
}

export type Segment = { t: string; hit: boolean };

/** Splits `text` into plain and highlighted pieces. */
export function segments(text: string, query: string): Segment[] {
	const ranges = matchRanges(text, query);
	if (!ranges.length) return [{ t: text, hit: false }];
	const out: Segment[] = [];
	let at = 0;
	for (const [s, e] of ranges) {
		if (s > at) out.push({ t: text.slice(at, s), hit: false });
		out.push({ t: text.slice(s, e), hit: true });
		at = e;
	}
	if (at < text.length) out.push({ t: text.slice(at), hit: false });
	return out;
}

/** A short excerpt around the first match, highlighted. */
export function snippet(text: string, query: string, before = 24, after = 60): Segment[] {
	const ranges = matchRanges(text, query);
	if (!ranges.length) return [{ t: text.slice(0, before + after), hit: false }];
	const from = Math.max(0, ranges[0][0] - before);
	const to = Math.min(text.length, ranges[0][1] + after);
	const cut = text.slice(from, to);
	const segs = segments(cut, query);
	if (from > 0) segs.unshift({ t: '…', hit: false });
	if (to < text.length) segs.push({ t: '…', hit: false });
	return segs;
}

export type GlobalHit = { chat: string; message: Message };
export const GLOBAL_LIMIT = 200;

/** Search across all chats; newest first within a chat, chats ordered by their newest hit. */
export function searchAll(chats: Record<string, readonly Message[]>, query: string): { groups: { chat: string; hits: Message[] }[]; total: number } {
	const groups: { chat: string; hits: Message[]; newest: number }[] = [];
	let total = 0;
	for (const [chat, list] of Object.entries(chats)) {
		const found = searchMessages(list, query);
		if (!found.length) continue;
		total += found.length;
		found.reverse();
		groups.push({ chat, hits: found, newest: found[0].ts });
	}
	groups.sort((a, b) => b.newest - a.newest);
	let room = GLOBAL_LIMIT;
	for (const g of groups) {
		g.hits = g.hits.slice(0, Math.max(0, room));
		room -= g.hits.length;
	}
	return { groups: groups.filter((g) => g.hits.length), total };
}
