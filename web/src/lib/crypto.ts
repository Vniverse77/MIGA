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
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';

export type Identity = { secret: Uint8Array; address: string };
/** A quoted message. It travels inside the ciphertext only; `text` is a short preview. */
export type Reply = { id: string; from: string; text: string };
/**
 * `del` makes the message a control message: it has no text and shows no bubble. Clients that
 * do not know it fail to read it (no `text`) and drop it.
 */
export type Plain = { text: string; ts: number; name?: string; reply?: Reply; del?: string[] };

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
	reply?: Reply
): string {
	return seal(
		id,
		peer,
		JSON.stringify({
			v: 0,
			text,
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
			const del = cleanIds(parsed.del);
			return del.length ? { text: '', ts: Number(parsed.ts) || Date.now(), del } : null;
		}
		return {
			text: parsed.text,
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
