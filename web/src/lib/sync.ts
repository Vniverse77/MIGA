// History transfer and delete tombstones for linked devices. See docs/PROTOCOL.md, "Full history
// transfer" and "Tombstones". Pure helpers only: nothing here touches the network or storage.
import { utf8ToBytes } from '@noble/hashes/utils';
import { isAddress } from './crypto';
import type { Chats, Contact, Message } from './storage';

// ── Tombstones ─────────────────────────────────────────────────────────────────────────────

/**
 * A remembered delete, so an offline device or a later history sync cannot bring the item back.
 * `m`: one message (`id`, `mine`). `c`: the whole conversation up to `ts`. `k`: the contact and
 * its conversation up to `ts`. Messages newer than `ts` are never covered by `c` or `k`.
 */
export type Tomb = { c: string; s: 'm' | 'c' | 'k'; id?: string; mine?: boolean; ts: number };

/** Tombstones are kept this long, then forgotten (a device offline for longer must be re-linked). */
export const TOMB_TTL_MS = 90 * 24 * 3600_000;
export const MAX_TOMBS = 5000;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function cleanTombs(value: unknown, now = Date.now()): Tomb[] {
	if (!Array.isArray(value)) return [];
	const out: Tomb[] = [];
	for (const item of value.slice(0, 500)) {
		const t = (item ?? {}) as Partial<Tomb>;
		if (typeof t.c !== 'string' || !isAddress(t.c)) continue;
		const ts = Number(t.ts);
		if (!Number.isFinite(ts) || ts <= 0 || ts > now + 24 * 3600_000) continue;
		if (t.s === 'c' || t.s === 'k') out.push({ c: t.c, s: t.s, ts: Math.floor(ts) });
		else if (t.s === 'm' && typeof t.id === 'string' && ID.test(t.id) && typeof t.mine === 'boolean')
			out.push({ c: t.c, s: 'm', id: t.id, mine: t.mine, ts: Math.floor(ts) });
	}
	return out;
}

const tombKey = (t: Tomb) => (t.s === 'm' ? `m|${t.c}|${t.mine ? 'm' : 't'}|${t.id}` : `${t.s}|${t.c}`);

/** Forgets old tombstones. Returns true if any went. */
export function pruneTombs(list: Tomb[], now = Date.now()): boolean {
	const before = list.length;
	const keep = list.filter((t) => now - t.ts < TOMB_TTL_MS);
	if (keep.length === before) return false;
	list.splice(0, list.length, ...keep);
	return true;
}

/** Adds tombstones (the newest per item wins). Returns the ones that were new or newer. */
export function addTombs(list: Tomb[], incoming: Tomb[]): Tomb[] {
	const index = new Map(list.map((t, i) => [tombKey(t), i]));
	const added: Tomb[] = [];
	for (const t of incoming) {
		const key = tombKey(t);
		const at = index.get(key);
		if (at === undefined) {
			index.set(key, list.push(t) - 1);
			added.push(t);
		} else if (list[at].ts < t.ts) {
			list[at] = t;
			added.push(t);
		}
	}
	// A conversation or contact tombstone covers older message tombstones of that chat.
	if (added.some((t) => t.s !== 'm')) {
		const cut = new Map<string, number>();
		for (const t of list) if (t.s !== 'm') cut.set(t.c, Math.max(cut.get(t.c) ?? 0, t.ts));
		const keep = list.filter((t) => t.s !== 'm' || t.ts > (cut.get(t.c) ?? 0));
		list.splice(0, list.length, ...keep);
	}
	if (list.length > MAX_TOMBS) list.splice(0, list.length - MAX_TOMBS);
	return added;
}

/** Answers "was this message deleted?" quickly for many messages. */
export function tombFilter(tombs: Tomb[]): (chat: string, m: { id: string; mine: boolean; ts: number }) => boolean {
	const msgs = new Set<string>();
	const cut = new Map<string, number>();
	for (const t of tombs) {
		if (t.s === 'm') msgs.add(tombKey(t));
		else cut.set(t.c, Math.max(cut.get(t.c) ?? 0, t.ts));
	}
	return (chat, m) =>
		msgs.has(`m|${chat}|${m.mine ? 'm' : 't'}|${m.id}`) || m.ts <= (cut.get(chat) ?? 0);
}

/** Timestamp of the contact tombstone of `address`, or 0. */
export function contactTombTs(tombs: Tomb[], address: string): number {
	let ts = 0;
	for (const t of tombs) if (t.s === 'k' && t.c === address) ts = Math.max(ts, t.ts);
	return ts;
}

/** Drops the contact tombstone of `address` (the contact was added again). Returns true if one went. */
export function clearContactTomb(tombs: Tomb[], address: string): boolean {
	const keep = tombs.filter((t) => !(t.s === 'k' && t.c === address));
	if (keep.length === tombs.length) return false;
	tombs.splice(0, tombs.length, ...keep);
	return true;
}

/**
 * Applies tombstones to local data in place: removes covered messages and tombstoned contacts.
 * Returns what changed so the caller can persist and fix its view.
 */
export function applyTombs(
	tombs: Tomb[],
	chats: Chats,
	contacts: Contact[]
): { messages: boolean; goneContacts: string[] } {
	const deleted = tombFilter(tombs);
	let messages = false;
	for (const [peer, list] of Object.entries(chats)) {
		for (let i = list.length - 1; i >= 0; i--) {
			if (deleted(peer, list[i])) {
				list.splice(i, 1);
				messages = true;
			}
		}
		if (!list.length && tombs.some((t) => t.c === peer && t.s !== 'm')) delete chats[peer];
	}
	const goneContacts: string[] = [];
	for (const t of tombs) {
		if (t.s !== 'k') continue;
		const i = contacts.findIndex((c) => c.address === t.c);
		if (i >= 0) {
			contacts.splice(i, 1);
			goneContacts.push(t.c);
		}
	}
	return { messages, goneContacts };
}

// ── History transfer ───────────────────────────────────────────────────────────────────────

/** Position in the canonical order (chat address, then ts, then id). Everything STRICTLY after it is next. */
export type Cursor = { c: string; t: number; i: string };

export const HISTORY_PAGE_BYTES = 12_000;

export function cleanCursor(value: unknown): Cursor | null {
	const c = (value ?? {}) as Partial<Cursor>;
	if (typeof c.c !== 'string' || !isAddress(c.c)) return null;
	if (typeof c.t !== 'number' || !Number.isFinite(c.t)) return null;
	if (typeof c.i !== 'string' || !ID.test(c.i)) return null;
	return { c: c.c, t: c.t, i: c.i };
}

const byTime = (a: Message, b: Message) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.mine === b.mine ? 0 : a.mine ? -1 : 1);

export function countMessages(chats: Chats): number {
	let n = 0;
	for (const list of Object.values(chats)) n += list.length;
	return n;
}

/**
 * The next page of history after `after` (null = from the start) and the cursor to ask for next
 * (null when this page was the last). Stateless: the answer depends only on the data and the
 * cursor, so a request can be repeated or resumed after a restart of either device.
 */
export function historyPage(
	chats: Chats,
	after: Cursor | null,
	maxBytes = HISTORY_PAGE_BYTES
): { chats: Chats; next: Cursor | null; count: number } {
	const out: Chats = {};
	let size = 0;
	let count = 0;
	let last: Cursor | null = null;
	const peers = Object.keys(chats).sort();
	for (const peer of peers) {
		if (after && peer < after.c) continue;
		const list = chats[peer].slice().sort(byTime);
		for (const m of list) {
			if (after && peer === after.c && (m.ts < after.t || (m.ts === after.t && m.id <= after.i))) continue;
			const bytes = utf8ToBytes(JSON.stringify(m)).length + 20;
			if (count > 0 && size + bytes > maxBytes) return { chats: out, next: last, count };
			(out[peer] ??= []).push(m);
			size += bytes;
			count++;
			last = { c: peer, t: m.ts, i: m.id };
		}
	}
	return { chats: out, next: null, count };
}

/** Saved on the NEW device while it copies history, so an interrupted copy resumes where it stopped. */
export type HistoryJob = {
	sid: string;
	/** The device asked first; others are tried if it stays silent. */
	from: string;
	cursor: Cursor | null;
	done: number;
	total: number;
};

export function cleanHistoryJob(value: unknown): HistoryJob | null {
	const j = (value ?? {}) as Partial<HistoryJob>;
	if (typeof j.sid !== 'string' || !ID.test(j.sid)) return null;
	if (typeof j.from !== 'string' || !isAddress(j.from)) return null;
	const cursor = j.cursor === null ? null : cleanCursor(j.cursor);
	if (j.cursor !== null && !cursor) return null;
	return { sid: j.sid, from: j.from, cursor, done: Math.max(0, Number(j.done) || 0), total: Math.max(0, Number(j.total) || 0) };
}

/** 0..100, never 100 before the job is really finished. */
export function historyPercent(job: HistoryJob): number {
	if (job.total <= 0) return 0;
	return Math.min(99, Math.floor((job.done / job.total) * 100));
}
