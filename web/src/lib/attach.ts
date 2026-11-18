// Encrypted attachments (photos, GIFs, short videos). See docs/PROTOCOL.md, "Attachments".
// The relay only ever stores the ciphertext produced here.
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';

/** Plaintext bytes per chunk. Every chunk but the last holds exactly this much. */
export const CHUNK = 64 * 1024;
const TAG = 16;
/** The largest file we send or accept (plaintext). The relay allows this plus the tags. */
export const MAX_ATTACHMENT = 25 * 1024 * 1024;
/** Longest edge of a re-encoded photo. */
export const MAX_EDGE = 2048;

/** Attachment metadata. It travels inside the end-to-end encrypted message only. */
export type Att = {
	/** Relay blob id, 32 hex. */
	blob: string;
	/** File key, 32 bytes, hex. */
	key: string;
	/** Base nonce, 24 bytes, hex. */
	nonce: string;
	/** SHA-256 of the plaintext file, hex. */
	hash: string;
	mime: string;
	/** Plaintext size in bytes. */
	size: number;
	w: number;
	h: number;
	/** Tiny blurred preview as a data URL (under 2 KB), may be empty. */
	thumb: string;
	/** Blob delete token. Kept only on the sender's own devices, never sent to the recipient. */
	del?: string;
};

const HEX32 = /^[0-9a-f]{32}$/;
const MIMES = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm))$/;
const THUMB = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]{0,4000}$/;

/** Validates attachment metadata from the network, storage or another device. Null when malformed. */
export function cleanAtt(value: unknown, withDelete = false): Att | null {
	const a = (value ?? {}) as Partial<Att>;
	if (typeof a.blob !== 'string' || !HEX32.test(a.blob)) return null;
	if (typeof a.key !== 'string' || !/^[0-9a-f]{64}$/.test(a.key)) return null;
	if (typeof a.nonce !== 'string' || !/^[0-9a-f]{48}$/.test(a.nonce)) return null;
	if (typeof a.hash !== 'string' || !/^[0-9a-f]{64}$/.test(a.hash)) return null;
	if (typeof a.mime !== 'string' || !MIMES.test(a.mime)) return null;
	const size = Number(a.size);
	if (!Number.isInteger(size) || size < 1 || size > MAX_ATTACHMENT) return null;
	const w = Math.round(Number(a.w));
	const h = Math.round(Number(a.h));
	if (!(w >= 1 && w <= 20000 && h >= 1 && h <= 20000)) return null;
	const thumb = typeof a.thumb === 'string' && THUMB.test(a.thumb) ? a.thumb : '';
	const del = withDelete && typeof a.del === 'string' && HEX32.test(a.del) ? a.del : undefined;
	return { blob: a.blob, key: a.key, nonce: a.nonce, hash: a.hash, mime: a.mime, size, w, h, thumb, ...(del ? { del } : {}) };
}

/** The nonce of chunk `i`: the base nonce with the counter XORed into its last 8 bytes (big endian). */
function chunkNonce(base: Uint8Array, i: number): Uint8Array {
	const n = base.slice();
	const view = new DataView(n.buffer, n.byteOffset);
	view.setUint32(16, view.getUint32(16) ^ Math.floor(i / 2 ** 32));
	view.setUint32(20, (view.getUint32(20) ^ i) >>> 0);
	return n;
}

// The AAD tells the last chunk from the others, so a truncated file never decrypts.
const AAD_MORE = Uint8Array.of(0);
const AAD_LAST = Uint8Array.of(1);

/** Encrypts a whole file. Returns the ciphertext and the metadata (without blob id and thumbnail). */
export function encryptFile(plain: Uint8Array): { cipher: Uint8Array; key: string; nonce: string; hash: string } {
	const key = randomBytes(32);
	const base = randomBytes(24);
	const count = Math.max(1, Math.ceil(plain.length / CHUNK));
	const cipher = new Uint8Array(plain.length + count * TAG);
	let out = 0;
	for (let i = 0; i < count; i++) {
		const part = plain.subarray(i * CHUNK, (i + 1) * CHUNK);
		const sealed = xchacha20poly1305(key, chunkNonce(base, i), i === count - 1 ? AAD_LAST : AAD_MORE).encrypt(part);
		cipher.set(sealed, out);
		out += sealed.length;
	}
	return { cipher, key: bytesToHex(key), nonce: bytesToHex(base), hash: bytesToHex(sha256(plain)) };
}

/** Decrypts and verifies a file. Throws on any tampering, truncation or hash mismatch. */
export function decryptFile(cipher: Uint8Array, att: Pick<Att, 'key' | 'nonce' | 'hash' | 'size'>): Uint8Array {
	const key = hexToBytes(att.key);
	const base = hexToBytes(att.nonce);
	const full = CHUNK + TAG;
	const count = Math.max(1, Math.ceil(cipher.length / full));
	if (att.size > MAX_ATTACHMENT || cipher.length !== att.size + count * TAG) throw new Error('size mismatch');
	const plain = new Uint8Array(att.size);
	let at = 0;
	for (let i = 0; i < count; i++) {
		const part = cipher.subarray(i * full, (i + 1) * full);
		const opened = xchacha20poly1305(key, chunkNonce(base, i), i === count - 1 ? AAD_LAST : AAD_MORE).decrypt(part);
		if (at + opened.length > plain.length) throw new Error('size mismatch');
		plain.set(opened, at);
		at += opened.length;
	}
	if (at !== plain.length || bytesToHex(sha256(plain)) !== att.hash) throw new Error('hash mismatch');
	return plain;
}

// ── Format sniffing ─────────────────────────────────────────────────────────────────

const ascii = (b: Uint8Array, at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/** True for animated GIF, animated WebP (ANIM chunk) and animated PNG (acTL chunk). */
export function isAnimated(head: Uint8Array, mime: string): boolean {
	if (mime === 'image/gif') return true;
	if (mime === 'image/webp') {
		for (let i = 12; i + 4 <= head.length; i++) if (ascii(head, i, 'ANIM')) return true;
		return false;
	}
	if (mime === 'image/png') {
		for (let i = 8; i + 4 <= head.length; i++) {
			if (ascii(head, i, 'IDAT')) return false;
			if (ascii(head, i, 'acTL')) return true;
		}
	}
	return false;
}

/** Detects the type from the first bytes (the browser-given type can be empty or wrong). */
export function sniffMime(b: Uint8Array): string {
	if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
	if (ascii(b, 1, 'PNG')) return 'image/png';
	if (ascii(b, 0, 'GIF8')) return 'image/gif';
	if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp';
	if (ascii(b, 4, 'ftyp')) return ascii(b, 8, 'heic') || ascii(b, 8, 'heix') || ascii(b, 8, 'mif1') ? 'image/heic' : 'video/mp4';
	if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
	return '';
}

export const extFor = (mime: string) =>
	({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' })[mime] ?? 'bin';
