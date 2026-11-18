// MIGA v0 cryptography. See docs/PROTOCOL.md. Only audited primitives from the noble
// libraries are used; nothing here invents a cipher.
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import {
	ed25519,
	edwardsToMontgomeryPriv,
	edwardsToMontgomeryPub,
	x25519
} from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import { cleanAtt, type Att } from './attach.ts';
import type { Message } from './storage';

export type Identity = { secret: Uint8Array; address: string };
/** A quoted message. It travels inside the ciphertext only; `text` is a short preview. */
export type Reply = { id: string; from: string; text: string };
/**
 * `del` makes the message a control message: it has no text and shows no bubble. Clients that
 * do not know it fail to read it (no `text`) and drop it.
 */
export type Plain = {
	text: string;
	ts: number;
	name?: string;
	reply?: Reply;
	del?: string[];
	/** Receipt control messages (no text, no bubble): ids of OUR messages the peer stored / read. */
	ack?: string[];
	seen?: string[];
	/** Edit control message (no top-level text, no bubble): replaces the text of one of the SENDER's messages. */
	edit?: Edit;
	/** Attachment (photo, GIF, video). `text` is then the caption, possibly empty. */
	att?: Att;
};
/**
 * Shown by clients that predate attachments (v0.5.0 needs a string `text` or it drops the message).
 * New clients never show it: they read the real caption from `cap` and ignore `text`.
 */
export const ATT_PLACEHOLDER = '[photo \u2014 update MIGA to view]';
/** The longest text of a message (also the longest an edit may carry). */
export const MAX_TEXT = 4000;
export type Edit = { id: string; text: string };

/** Validates an edit from the network. Null when malformed, empty or too long. */
export function cleanEdit(value: unknown): Edit | null {
	const edit = (value ?? {}) as Partial<Edit>;
	if (typeof edit.id !== 'string' || !ID_PATTERN.test(edit.id)) return null;
	if (typeof edit.text !== 'string' || edit.text.length > MAX_TEXT) return null;
	const text = edit.text.trim();
	return text ? { id: edit.id, text } : null;
}

/** The most message ids one delete request may carry. */
export const MAX_DELETE = 50;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Validates a list of message ids from the network. Drops what is malformed, caps the length. */
export function cleanIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const ids = value.filter((id): id is string => typeof id === 'string' && ID_PATTERN.test(id));
	return [...new Set(ids)].slice(0, MAX_DELETE);
}

export const REPLY_PREVIEW = 120;

/** Validates a reply from the network, storage or another device. Returns null when malformed. */
export function cleanReply(value: unknown): Reply | null {
	const reply = (value ?? {}) as Partial<Reply>;
	if (typeof reply.id !== 'string' || !ID_PATTERN.test(reply.id)) return null;
	if (typeof reply.from !== 'string' || !isAddress(reply.from)) return null;
	if (typeof reply.text !== 'string') return null;
	const line = reply.text.slice(0, 2000).trim().split(/\r?\n/)[0].trim();
	const text = [...line].slice(0, REPLY_PREVIEW).join('');
	if (!text) return null;
	return { id: reply.id, from: reply.from, text };
}

const PAD = 256;
const NONCE = 24;

export function newIdentity(): Identity {
	return identityFromSecret(ed25519.utils.randomPrivateKey());
}

export function identityFromSecret(secret: Uint8Array): Identity {
	if (secret.length !== 32) throw new Error('secret key must be 32 bytes');
	return { secret, address: bytesToHex(ed25519.getPublicKey(secret)) };
}

const PROBE = new Uint8Array(32).fill(7);

export function isAddress(value: string): boolean {
	if (!/^[0-9a-f]{64}$/.test(value)) return false;
	try {
		// Also rejects low-order points, which would make key agreement throw later.
		x25519.getSharedSecret(PROBE, edwardsToMontgomeryPub(hexToBytes(value)));
		return true;
	} catch {
		return false;
	}
}

export function signAuth(id: Identity, nonce: string): string {
	return bytesToHex(ed25519.sign(utf8ToBytes('miga-auth-v0:' + nonce), id.secret));
}

const keyCache = new Map<string, Uint8Array>();

function sharedKey(id: Identity, peer: string): Uint8Array {
	const cacheId = id.address + peer;
	let key = keyCache.get(cacheId);
	if (!key) {
		const shared = x25519.getSharedSecret(
			edwardsToMontgomeryPriv(id.secret),
			edwardsToMontgomeryPub(hexToBytes(peer))
		);
		const info = [id.address, peer].sort().join('');
		key = hkdf(sha256, shared, utf8ToBytes('miga-v0'), utf8ToBytes(info), 32);
		keyCache.set(cacheId, key);
	}
	return key;
}

/** `name` is the sender's optional display name. It travels inside the ciphertext only. */
export function encrypt(
	id: Identity,
	peer: string,
	text: string,
	name?: string,
	reply?: Reply,
	att?: Att
): string {
	// With an attachment, `text` is the old-client fallback and `cap` the real caption.
	const wire = att
		? { text: text ? `${text}\n${ATT_PLACEHOLDER}` : ATT_PLACEHOLDER, cap: text, att: { ...att, del: undefined } }
		: { text };
	return seal(
		id,
		peer,
		JSON.stringify({
			v: 0,
			...wire,
			ts: Date.now(),
			...(name ? { name } : {}),
			...(reply ? { reply } : {})
		})
	);
}

/** Control message: asks the peer to remove these messages that we sent. Shows no bubble. */
export function encryptDelete(id: Identity, peer: string, ids: string[]): string {
	return seal(id, peer, JSON.stringify({ v: 0, ts: Date.now(), del: cleanIds(ids) }));
}

/** Clamp for an edit timestamp: a clock far in the future must not block later edits. */
export function editTime(ts: unknown, now = Date.now()): number {
	const n = Number(ts);
	return Number.isFinite(n) && n > 0 ? Math.min(n, now + 86_400_000) : now;
}

/**
 * Applies an edit to the message `id` of `list`. `mine` says whose message it is: a network edit
 * from a peer passes `mine: false` with that peer's own chat list, so it can only ever reach a
 * message that peer sent. The last edit wins by `ts`. Returns true if the text changed.
 */
export function applyEdit(
	list: Message[],
	edit: { id: string; mine: boolean; text: string; ts: number }
): boolean {
	const clean = cleanEdit({ id: edit.id, text: edit.text });
	if (!clean) return false;
	const ts = editTime(edit.ts);
	const target = list.find((m) => m.mine === edit.mine && m.id === clean.id);
	// A deleted message is simply gone from the list, so an edit after delete finds nothing.
	if (!target || ts <= (target.edited ?? 0)) return false;
	target.edited = ts;
	if (target.text === clean.text) return true;
	target.text = clean.text;
	return true;
}

/**
 * Edit control message: replaces the text of one of our own messages. It has no top-level
 * `text`, so v0.5.0 clients cannot read it and drop it. The receiver only applies it to a message
 * that came from this very sender.
 */
export function encryptEdit(
	id: Identity,
	peer: string,
	messageId: string,
	text: string,
	ts = Date.now()
): string {
	return seal(id, peer, JSON.stringify({ v: 0, ts, edit: { id: messageId, text } }));
}

/**
 * Receipt control message: `ack` = the peer's device stored these messages of ours, `seen` = the
 * user looked at them (only sent when read receipts are on). No `text`, so v0.5.0 clients drop it.
 */
export function encryptReceipt(
	id: Identity,
	peer: string,
	kind: 'ack' | 'seen',
	ids: string[]
): string {
	return seal(id, peer, JSON.stringify({ v: 0, ts: Date.now(), [kind]: cleanIds(ids) }));
}

function seal(id: Identity, peer: string, plaintext: string): string {
	const json = utf8ToBytes(plaintext);
	const padded = new Uint8Array(Math.ceil(json.length / PAD) * PAD).fill(0x20);
	padded.set(json);
	const nonce = randomBytes(NONCE);
	const sealed = xchacha20poly1305(sharedKey(id, peer), nonce).encrypt(padded);
	const out = new Uint8Array(NONCE + sealed.length);
	out.set(nonce);
	out.set(sealed, NONCE);
	return toBase64(out);
}

/** Returns null when the body is not a valid message from `peer` to us. */
export function decrypt(id: Identity, peer: string, body: string): Plain | null {
	try {
		const raw = fromBase64(body);
		const opened = xchacha20poly1305(sharedKey(id, peer), raw.subarray(0, NONCE)).decrypt(
			raw.subarray(NONCE)
		);
		const parsed = JSON.parse(new TextDecoder().decode(opened));
		if (parsed?.v !== 0) return null;
		if (typeof parsed.text !== 'string') {
			const ts = Number(parsed.ts) || Date.now();
			const del = cleanIds(parsed.del);
			if (del.length) return { text: '', ts, del };
			const edit = cleanEdit(parsed.edit);
			if (edit) return { text: '', ts, edit };
			const ack = cleanIds(parsed.ack);
			const seen = cleanIds(parsed.seen);
			return ack.length || seen.length
				? { text: '', ts, ...(ack.length ? { ack } : {}), ...(seen.length ? { seen } : {}) }
				: null;
		}
		const att = parsed.att === undefined ? null : cleanAtt(parsed.att);
		if (parsed.att !== undefined && !att) return null;
		return {
			text: att ? (typeof parsed.cap === 'string' ? parsed.cap.slice(0, MAX_TEXT) : '') : parsed.text,
			...(att ? { att } : {}),
			ts: Number(parsed.ts) || Date.now(),
			name: typeof parsed.name === 'string' ? parsed.name : undefined,
			reply: cleanReply(parsed.reply) ?? undefined
		};
	} catch {
		return null;
	}
}

export function randomId(): string {
	return bytesToHex(randomBytes(16));
}

export { bytesToHex, hexToBytes };

export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/**
 * Safety number of a pair of accounts: 60 digits, identical on both sides. SHA-512 over
 * "MIGA-safety-v1" 0x00 lo hi, where lo and hi are the two 32-byte identity public keys
 * (account addresses) sorted bytewise. Digits 5i..5i+4 are the 5-byte big-endian integer
 * at hash offset 5i, modulo 100000. See docs/PROTOCOL.md.
 */
export function safetyNumber(mine: string, theirs: string): string {
	const [lo, hi] = [mine.toLowerCase(), theirs.toLowerCase()].sort();
	const hash = sha512(Uint8Array.from([...utf8ToBytes('MIGA-safety-v1'), 0, ...hexToBytes(lo), ...hexToBytes(hi)]));
	let out = '';
	for (let i = 0; i < 12; i++) {
		let n = 0;
		for (let j = 0; j < 5; j++) n = n * 256 + hash[i * 5 + j];
		out += String(n % 100000).padStart(5, '0');
	}
	return out;
}

/** "12345 67890 ..." for display; the stored form has no spaces. */
export function groupSafety(number: string): string {
	return number.match(/.{5}/g)?.join(' ') ?? number;
}

export const isSafetyNumber = (value: unknown): value is string =>
	typeof value === 'string' && /^\d{60}$/.test(value);
