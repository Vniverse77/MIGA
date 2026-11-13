// Linked devices: one account key used on several devices. See docs/PROTOCOL.md.
// Nothing here needs the relay's help: it only ever sees opaque bodies between addresses.
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { scryptAsync } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha2';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import { cleanIds, cleanReply, fromBase64, identityFromSecret, isAddress, toBase64, type Identity } from './crypto';
import { MAX_BLOCKED, type Chats, type Contact, type Device, type Message, type Profile } from './storage';
import { platform } from './platform';

/** How long a link code stays valid. */
export const LINK_TTL_MS = 10 * 60_000;

const CODE_LENGTH = 12;
// Crockford base32: no I, L, O or U, so a code read aloud or typed by hand is unambiguous.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAD = 256;
const NONCE = 24;

/** First message of a link: sealed with the key derived from the code. */
export type LinkBundle = {
	k: 'link';
	/** Account secret key, hex. */
	secret: string;
	/** Device address of the device that showed the code; it sends the history afterwards. */
	sponsor: string;
	/** Unix ms after which the bundle must be ignored. */
	exp: number;
	profile: Profile;
	/** Every device already in the account, including the sponsor. */
	devices: Device[];
};

/** Messages between devices of one account, sealed with the account's sync key. */
export type SyncMessage =
	| { k: 'hello'; label: string; sponsor: string }
	| {
			k: 'state';
			profile?: Profile;
			contacts?: Contact[];
			devices?: Device[];
			/** The complete block list; it replaces the one on the receiving device. */
			blocked?: string[];
	  }
	| { k: 'history'; chats: Chats }
	| { k: 'msg'; peer: string; message: Message; name?: string }
	| { k: 'del'; peer: string; items: { id: string; mine: boolean }[] }
	| { k: 'bye'; address: string };

/** 12 characters, 60 bits. The slow key derivation below is what makes that enough. */
export function newLinkCode(): string {
	let code = '';
	for (const byte of randomBytes(CODE_LENGTH)) code += ALPHABET[byte & 31];
	return code;
}

export function formatLinkCode(code: string): string {
	return code.match(/.{1,4}/g)?.join('-') ?? code;
}

/** Accepts what a person types: any case, dashes or spaces, O for 0, I or L for 1. */
export function normalizeLinkCode(input: string): string | null {
	const code = input
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, '')
		.replace(/O/g, '0')
		.replace(/[IL]/g, '1');
	if (code.length !== CODE_LENGTH) return null;
	for (const char of code) if (!ALPHABET.includes(char)) return null;
	return code;
}

/**
 * Turns a code into a throwaway mailbox address plus the key that seals the bundle.
 * scrypt makes guessing codes expensive for anyone who recorded the mailbox address.
 */
export async function deriveLink(code: string): Promise<{ identity: Identity; key: Uint8Array }> {
	const out = await scryptAsync(utf8ToBytes(code), utf8ToBytes('miga-link-v0'), {
		N: 2 ** 15,
		r: 8,
		p: 1,
		dkLen: 64
	});
	return { identity: identityFromSecret(out.slice(0, 32)), key: out.slice(32) };
}

/** Only devices holding the account secret can derive this, so it also proves membership. */
export function syncKey(account: Identity): Uint8Array {
	return hkdf(sha256, account.secret, utf8ToBytes('miga-v0'), utf8ToBytes('sync'), 32);
}

/** `bind` ties the ciphertext to its sender and recipient so it cannot be replayed elsewhere. */
export function seal(key: Uint8Array, value: unknown, bind = ''): string {
	const json = utf8ToBytes(JSON.stringify(value));
	const padded = new Uint8Array(Math.ceil(json.length / PAD) * PAD).fill(0x20);
	padded.set(json);
	const nonce = randomBytes(NONCE);
	const sealed = xchacha20poly1305(key, nonce, utf8ToBytes(bind)).encrypt(padded);
	const out = new Uint8Array(NONCE + sealed.length);
	out.set(nonce);
	out.set(sealed, NONCE);
	return toBase64(out);
}

export function open<T>(key: Uint8Array, body: string, bind = ''): T | null {
	try {
		const raw = fromBase64(body);
		const opened = xchacha20poly1305(key, raw.subarray(0, NONCE), utf8ToBytes(bind)).decrypt(
			raw.subarray(NONCE)
		);
		return JSON.parse(new TextDecoder().decode(opened)) as T;
	} catch {
		return null;
	}
}

// Everything below treats synced data as untrusted input, even though it comes from our own
// devices: a bug or an old version on one device must not corrupt another.

const cleanName = (value: unknown) =>
	typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 40) : '';

export function cleanProfile(value: unknown): Profile {
	const profile = (value ?? {}) as Partial<Profile>;
	return { name: cleanName(profile.name), share: profile.share !== false };
}

export function cleanContact(value: unknown): Contact | null {
	const contact = (value ?? {}) as Partial<Contact>;
	if (typeof contact.address !== 'string' || !isAddress(contact.address)) return null;
	const name = cleanName(contact.name);
	if (!name) return null;
	return { address: contact.address, name, ...(contact.custom === true ? { custom: true } : {}) };
}

export function cleanDevices(value: unknown): Device[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: Device[] = [];
	for (const item of value.slice(0, 20)) {
		const device = (item ?? {}) as Partial<Device>;
		if (typeof device.address !== 'string' || !isAddress(device.address)) continue;
		if (seen.has(device.address)) continue;
		seen.add(device.address);
		out.push({
			address: device.address,
			label: cleanName(device.label) || 'Device',
			added: Number(device.added) || Date.now()
		});
	}
	return out;
}

/** A block list from another device: valid addresses only, no duplicates, length-capped. */
export function cleanBlocked(value: unknown, own?: string): string[] {
	if (!Array.isArray(value)) return [];
	const list = value.filter((a): a is string => typeof a === 'string' && a !== own && isAddress(a));
	return [...new Set(list)].slice(0, MAX_BLOCKED);
}

/** Validates the `items` of a `del` sync message. */
export function cleanDeleteItems(value: unknown): { id: string; mine: boolean }[] {
	if (!Array.isArray(value)) return [];
	const out: { id: string; mine: boolean }[] = [];
	for (const item of value.slice(0, 100)) {
		const { id, mine } = (item ?? {}) as { id?: unknown; mine?: unknown };
		const clean = cleanIds([id]);
		if (clean.length && typeof mine === 'boolean') out.push({ id: clean[0], mine });
	}
	return out;
}

/** Removes the listed messages in place. Returns true if anything was removed. */
export function removeMessages(list: Message[], items: { id: string; mine: boolean }[]): boolean {
	const gone = new Set(items.map((i) => (i.mine ? 'm' : 't') + i.id));
	let changed = false;
	for (let i = list.length - 1; i >= 0; i--) {
		if (gone.has((list[i].mine ? 'm' : 't') + list[i].id)) {
			list.splice(i, 1);
			changed = true;
		}
	}
	return changed;
}

export function cleanMessage(value: unknown, maxText: number): Message | null {
	const message = (value ?? {}) as Partial<Message>;
	if (typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(message.id)) return null;
	if (typeof message.text !== 'string' || typeof message.mine !== 'boolean') return null;
	const ts = Number(message.ts);
	if (!Number.isFinite(ts)) return null;
	// A copy is never "pending" here: only the device that wrote a message sends it.
	const state = message.mine ? (message.state === 'failed' ? 'failed' : 'sent') : 'received';
	const reply = message.reply === undefined ? null : cleanReply(message.reply);
	return {
		id: message.id,
		mine: message.mine,
		text: message.text.slice(0, maxText),
		ts,
		state,
		...(reply ? { reply } : {})
	};
}

/** Adds messages that are not there yet and keeps the list in time order. Returns true if it changed. */
export function mergeMessages(list: Message[], incoming: Message[]): boolean {
	const known = new Set(list.map((m) => (m.mine ? 'm' : 't') + m.id));
	let changed = false;
	for (const message of incoming) {
		const key = (message.mine ? 'm' : 't') + message.id;
		if (known.has(key)) continue;
		known.add(key);
		list.push(message);
		changed = true;
	}
	if (changed) list.sort((a, b) => a.ts - b.ts);
	return changed;
}

/** Splits recent history into pieces small enough for one relay message each. */
export function historyChunks(chats: Chats, perChat = 200, maxBytes = 12_000, maxChunks = 40): Chats[] {
	const chunks: Chats[] = [];
	let current: Chats = {};
	let size = 0;
	for (const [peer, list] of Object.entries(chats)) {
		for (const message of list.slice(-perChat)) {
			const bytes = utf8ToBytes(JSON.stringify(message)).length + 80;
			if (size > 0 && size + bytes > maxBytes) {
				chunks.push(current);
				current = {};
				size = 0;
			}
			(current[peer] ??= []).push(message);
			size += bytes;
		}
	}
	if (size > 0) chunks.push(current);
	// Newest chunks matter most when there is too much to send.
	return chunks.slice(-maxChunks);
}

/** A short label such as "Android · Chrome". It is shown only on the user's own devices. */
export function guessDeviceLabel(): string {
	const ua = navigator.userAgent;
	const os = /Android/.test(ua)
		? 'Android'
		: /iPhone|iPad/.test(ua)
			? 'iOS'
			: /Windows/.test(ua)
				? 'Windows'
				: /Mac OS/.test(ua)
					? 'macOS'
					: /Linux/.test(ua)
						? 'Linux'
						: 'Device';
	// The packaged apps embed a system web view that reports a browser name (WebKitGTK says Safari),
	// so the build target decides, not the user agent.
	if (platform.target === 'desktop') return `${os} · MIGA Desktop`;
	if (platform.target === 'mobile') return `${os} · MIGA Mobile`;
	const browser = /Firefox\//.test(ua)
		? 'Firefox'
		: /Edg\//.test(ua)
			? 'Edge'
			: /Chrome\//.test(ua)
				? 'Chrome'
				: /Safari\//.test(ua)
					? 'Safari'
					: '';
	return browser ? `${os} · ${browser}` : os;
}
