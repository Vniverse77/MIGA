// Shared helpers for gen-vectors.ts and check-vectors.ts: deterministic randomness and the
// REAL web modules (imported, never copied). Run through `deno task vectors` in web/.
(globalThis as unknown as { __MIGA_TARGET__: string }).__MIGA_TARGET__ = 'web';

import {
	bytesToHex,
	edwardsToMontgomeryPriv,
	edwardsToMontgomeryPub,
	ed25519,
	hexToBytes,
	hkdf,
	sha256,
	sha512,
	utf8ToBytes,
	x25519,
	xchacha20poly1305
} from '../web/scripts/vector-deps.ts';

export const crypto_ = await import('../web/src/lib/crypto.ts');
export const attach = await import('../web/src/lib/attach.ts');
export const devices = await import('../web/src/lib/devices.ts');
export const sync = await import('../web/src/lib/sync.ts');
export { bytesToHex, hexToBytes, sha256, sha512, utf8ToBytes, ed25519, x25519, xchacha20poly1305 };

/** The clock every vector uses (2023-11-14T22:13:20Z). */
export const NOW = 1_700_000_000_000;

// ── Deterministic randomness ──────────────────────────────────────────────────────────────
// noble's randomBytes() calls globalThis.crypto.getRandomValues() on every use, so replacing
// that one method makes every "random" value in the real modules reproducible.
// Stream: block i = SHA-256("miga-vectors-v1" || u32be(i)). `force()` queues exact bytes that
// the NEXT randomBytes() call(s) return instead (used for nonces and file keys).

const forced: Uint8Array[] = [];
let counter = 0;
let pool = new Uint8Array(0);

function stream(n: number): Uint8Array {
	while (pool.length < n) {
		const block = new Uint8Array(15 + 4);
		block.set(utf8ToBytes('miga-vectors-v1'));
		new DataView(block.buffer).setUint32(15, counter++);
		const next = sha256(block);
		const merged = new Uint8Array(pool.length + next.length);
		merged.set(pool);
		merged.set(next, pool.length);
		pool = merged;
	}
	const out = pool.slice(0, n);
	pool = pool.slice(n);
	return out;
}

export function resetRng(): void {
	forced.length = 0;
	counter = 0;
	pool = new Uint8Array(0);
}

/** The next randomBytes() call returns exactly these bytes. */
export function force(bytes: Uint8Array | string): void {
	forced.push(typeof bytes === 'string' ? hexToBytes(bytes) : bytes);
}

export function installDeterminism(): void {
	// deno-lint-ignore no-explicit-any
	(globalThis.crypto as any).getRandomValues = (arr: Uint8Array) => {
		const next = forced.shift();
		if (next && next.length !== arr.length) throw new Error(`forced ${next.length} bytes, asked for ${arr.length}`);
		arr.set(next ?? stream(arr.length));
		return arr;
	};
	Date.now = () => NOW;
}

/** Labelled 32-byte seed, so vectors never depend on a real key. */
export const seedOf = (label: string): string => bytesToHex(sha256(utf8ToBytes('miga-vectors-seed/' + label)));

// ── Independent reference derivations (used to document intermediates and to cross-check) ─

export function pairKey(mySeedHex: string, peerAddress: string): { shared: string; info: string; key: string } {
	const me = crypto_.identityFromSecret(hexToBytes(mySeedHex));
	const shared = x25519.getSharedSecret(edwardsToMontgomeryPriv(me.secret), edwardsToMontgomeryPub(hexToBytes(peerAddress)));
	const info = [me.address, peerAddress].sort().join('');
	const key = hkdf(sha256, shared, utf8ToBytes('miga-v0'), utf8ToBytes(info), 32);
	return { shared: bytesToHex(shared), info, key: bytesToHex(key) };
}

const PAD = 256;
/** Opens an envelope body with a known key. Returns nonce, the padded plaintext as text. */
export function openEnvelope(keyHex: string, body: string, aad = ''): { nonce: string; padded: string; plaintext: string; paddedLen: number } {
	const raw = crypto_.fromBase64(body);
	const opened = xchacha20poly1305(hexToBytes(keyHex), raw.subarray(0, 24), utf8ToBytes(aad)).decrypt(raw.subarray(24));
	const padded = new TextDecoder().decode(opened);
	return { nonce: bytesToHex(raw.subarray(0, 24)), padded, plaintext: padded.replace(/ +$/, ''), paddedLen: opened.length };
}
export { PAD };

export const hex = bytesToHex;
export const fromHex = hexToBytes;
export { edwardsToMontgomeryPriv, edwardsToMontgomeryPub, sha512 as sha512_ };

/** Reference chunk nonce: base XOR big-endian 64-bit counter in the last 8 bytes. */
export function refChunkNonce(base: Uint8Array, i: bigint): Uint8Array {
	const n = base.slice();
	for (let k = 0; k < 8; k++) n[23 - k] ^= Number((i >> BigInt(8 * k)) & 0xffn);
	return n;
}
