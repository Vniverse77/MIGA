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
export type Plain = { text: string; ts: number; name?: string };

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
export function encrypt(id: Identity, peer: string, text: string, name?: string): string {
	const json = utf8ToBytes(
		JSON.stringify({ v: 0, text, ts: Date.now(), ...(name ? { name } : {}) })
	);
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
		if (parsed?.v !== 0 || typeof parsed.text !== 'string') return null;
		return {
			text: parsed.text,
			ts: Number(parsed.ts) || Date.now(),
			name: typeof parsed.name === 'string' ? parsed.name : undefined
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
