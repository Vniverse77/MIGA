// Pinned messages. LOCAL to the devices of one account: a pin is never sent to the other person
// (privacy, and nothing for the other side to see or lose). Linked devices share them through the
// encrypted sync channel (`state.pins`). Pure helpers only; storage.ts persists, Messenger.svelte renders.
import { isAddress } from './crypto';

/** chat address -> message keys, newest pin first. A key is 'm' (mine) or 't' (theirs) plus the message id. */
export type Pins = Record<string, string[]>;

export const MAX_PINS = 3;
/** A chat key is a contact address or a group id (32 hex). */
export const isChatKey = (v: string): boolean => isAddress(v) || /^[0-9a-f]{32}$/.test(v);
const KEY = /^[mt][A-Za-z0-9_-]{1,64}$/;

export const pinKey = (m: { id: string; mine: boolean }): string => (m.mine ? 'm' : 't') + m.id;

/** Treats stored or synced data as untrusted input. */
export function cleanPins(value: unknown): Pins {
	const out: Pins = {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
	for (const [peer, list] of Object.entries(value as Record<string, unknown>)) {
		if (!isChatKey(peer) || !Array.isArray(list)) continue;
		const keys = [...new Set(list.filter((k): k is string => typeof k === 'string' && KEY.test(k)))].slice(0, MAX_PINS);
		if (keys.length) out[peer] = keys;
	}
	return out;
}

export function isPinned(pins: Pins, peer: string, key: string): boolean {
	return pins[peer]?.includes(key) === true;
}

/** Pins or unpins in place. A fourth pin pushes the oldest one out. Returns true when the message is pinned afterwards. */
export function togglePin(pins: Pins, peer: string, key: string): boolean {
	const list = pins[peer] ?? [];
	if (list.includes(key)) {
		unpin(pins, peer, key);
		return false;
	}
	pins[peer] = [key, ...list].slice(0, MAX_PINS);
	return true;
}

/** Removes one pin. Returns true if there was one. */
export function unpin(pins: Pins, peer: string, key: string): boolean {
	const list = pins[peer];
	if (!list?.includes(key)) return false;
	const rest = list.filter((k) => k !== key);
	if (rest.length) pins[peer] = rest;
	else delete pins[peer];
	return true;
}

/** Drops pins whose message is gone from `have` (the keys present in the chat). Returns true if any went. */
export function prunePins(pins: Pins, peer: string, have: Set<string>): boolean {
	const list = pins[peer];
	if (!list) return false;
	const keep = list.filter((k) => have.has(k));
	if (keep.length === list.length) return false;
	if (keep.length) pins[peer] = keep;
	else delete pins[peer];
	return true;
}

// ── Pinned chats (top of the chat list) ──────────────────────────────────────────────────

export const MAX_PINNED_CHATS = 5;

/** Everything pinned on this account: messages per chat and chats in list order (first = top). */
export type PinState = { m: Pins; c: string[] };

export const emptyPinState = (): PinState => ({ m: {}, c: [] });

export function cleanPinState(value: unknown): PinState {
	const v = (value && typeof value === 'object' ? value : {}) as Partial<PinState>;
	const c = Array.isArray(v.c)
		? [...new Set(v.c.filter((a): a is string => typeof a === 'string' && isChatKey(a)))].slice(0, MAX_PINNED_CHATS)
		: [];
	return { m: cleanPins(v.m), c };
}

/** Pins a chat (newest on top, the oldest falls off after five) or unpins it. True when pinned afterwards. */
export function toggleChatPin(chats: string[], address: string): boolean {
	const at = chats.indexOf(address);
	if (at >= 0) {
		chats.splice(at, 1);
		return false;
	}
	chats.unshift(address);
	if (chats.length > MAX_PINNED_CHATS) chats.length = MAX_PINNED_CHATS;
	return true;
}

/** Pinned chats first in pin order, the rest keep their order. */
export function orderWithPins<T extends { address: string }>(list: T[], pinned: string[]): T[] {
	const rank = (a: string) => {
		const i = pinned.indexOf(a);
		return i < 0 ? Infinity : i;
	};
	return list
		.map((c, i) => ({ c, i }))
		.sort((x, y) => (rank(x.c.address) === rank(y.c.address) ? x.i - y.i : rank(x.c.address) - rank(y.c.address)))
		.map((x) => x.c);
}
