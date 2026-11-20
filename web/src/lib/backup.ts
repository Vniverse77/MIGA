// Key backup format (docs/BACKUP.md). Pure functions, no storage and no network: a backup is only ever
// produced on this device and handed to the person, never uploaded. Only noble primitives are used:
// scrypt (the KDF already used for link codes) and XChaCha20-Poly1305.
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { scryptAsync } from '@noble/hashes/scrypt';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils';

export const MAGIC = [0x4d, 0x49, 0x47, 0x41]; // "MIGA"
export const VERSION = 1;
/** What the container holds. */
export const KIND_FILE = 1;
export const KIND_KEY = 2;
export type Kind = typeof KIND_FILE | typeof KIND_KEY;
const KDF_SCRYPT = 1;
const FLAG_DEFLATE = 1;

export type Kdf = { logN: number; r: number; p: number };
/** 64 MiB of memory (128 * N * r) and two passes: OWASP's scrypt parameter set that fits a phone. */
export const DEFAULT_KDF: Kdf = { logN: 16, r: 8, p: 2 };
/** What a file may ask for. A hostile file must not be able to demand gigabytes of memory. */
export const MAX_KDF: Kdf = { logN: 18, r: 16, p: 4 };
export const MIN_LOG_N = 12;

export const SALT = 16;
export const NONCE = 24;
export const TAG = 16;
/** magic 4, version, kind, flags, kdf id, logN, r, p, salt, nonce. */
export const HEADER = 4 + 7 + SALT + NONCE;
export const MIN_PASSPHRASE = 10;
/** The most plaintext a backup may expand to; guards against decompression bombs. */
const MAX_PLAIN = 256 * 1024 * 1024;

export type BackupErrorCode = 'format' | 'version' | 'params' | 'passphrase' | 'unsupported';
export class BackupError extends Error {
	constructor(readonly code: BackupErrorCode) {
		super(code);
	}
}

export type Header = { kind: Kind; flags: number; kdf: Kdf; salt: Uint8Array; nonce: Uint8Array };

/** The passphrase as bytes: NFKC-normalised so the same word typed on another keyboard still opens it. */
export function passphraseBytes(passphrase: string): Uint8Array {
	return utf8ToBytes(passphrase.normalize('NFKC'));
}

export function parseHeader(bytes: Uint8Array): Header {
	if (bytes.length < HEADER + TAG || MAGIC.some((b, i) => bytes[i] !== b)) throw new BackupError('format');
	if (bytes[4] !== VERSION) throw new BackupError('version');
	const kind = bytes[5];
	if (kind !== KIND_FILE && kind !== KIND_KEY) throw new BackupError('format');
	if (bytes[7] !== KDF_SCRYPT) throw new BackupError('version');
	const kdf = { logN: bytes[8], r: bytes[9], p: bytes[10] };
	if (
		kdf.logN < MIN_LOG_N ||
		kdf.logN > MAX_KDF.logN ||
		kdf.r < 1 ||
		kdf.r > MAX_KDF.r ||
		kdf.p < 1 ||
		kdf.p > MAX_KDF.p
	) {
		throw new BackupError('params');
	}
	return {
		kind,
		flags: bytes[6],
		kdf,
		salt: bytes.slice(11, 11 + SALT),
		nonce: bytes.slice(11 + SALT, HEADER)
	};
}

function deriveKey(passphrase: string, salt: Uint8Array, kdf: Kdf): Promise<Uint8Array> {
	return scryptAsync(passphraseBytes(passphrase), salt, {
		N: 2 ** kdf.logN,
		r: kdf.r,
		p: kdf.p,
		dkLen: 32,
		// Lets the interface stay responsive while the key is derived.
		asyncTick: 10
	});
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
	const writer = stream.writable.getWriter();
	void writer.write(bytes as BufferSource).then(() => writer.close()).catch(() => {});
	const reader = stream.readable.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > limit) {
			void reader.cancel();
			throw new BackupError('format');
		}
		parts.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

const canDeflate = (): boolean => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

export type SealOptions = { kdf?: Kdf; salt?: Uint8Array; nonce?: Uint8Array; compress?: boolean };

/**
 * Builds a container: header, then XChaCha20-Poly1305 over the payload with the whole header as
 * associated data, so neither the KDF settings nor the kind can be changed without breaking the tag.
 */
export async function seal(kind: Kind, payload: Uint8Array, passphrase: string, options: SealOptions = {}): Promise<Uint8Array> {
	const kdf = options.kdf ?? DEFAULT_KDF;
	const deflate = (options.compress ?? kind === KIND_FILE) && canDeflate();
	const salt = options.salt ?? randomBytes(SALT);
	const nonce = options.nonce ?? randomBytes(NONCE);
	const plain = deflate ? await pipe(payload, new CompressionStream('deflate-raw'), MAX_PLAIN) : payload;
	const head = new Uint8Array(HEADER);
	head.set(MAGIC);
	head.set([VERSION, kind, deflate ? FLAG_DEFLATE : 0, KDF_SCRYPT, kdf.logN, kdf.r, kdf.p], 4);
	head.set(salt, 11);
	head.set(nonce, 11 + SALT);
	const key = await deriveKey(passphrase, salt, kdf);
	const sealed = xchacha20poly1305(key, nonce, head).encrypt(plain);
	key.fill(0);
	const out = new Uint8Array(HEADER + sealed.length);
	out.set(head);
	out.set(sealed, HEADER);
	return out;
}

/** Opens a container. A wrong passphrase and a damaged file are both `passphrase` (the tag cannot tell them apart). */
export async function open(bytes: Uint8Array, passphrase: string): Promise<{ kind: Kind; payload: Uint8Array }> {
	const header = parseHeader(bytes);
	const key = await deriveKey(passphrase, header.salt, header.kdf);
	let plain: Uint8Array;
	try {
		plain = xchacha20poly1305(key, header.nonce, bytes.subarray(0, HEADER)).decrypt(bytes.subarray(HEADER));
	} catch {
		throw new BackupError('passphrase');
	} finally {
		key.fill(0);
	}
	if (header.flags & FLAG_DEFLATE) {
		if (!canDeflate()) throw new BackupError('unsupported');
		plain = await pipe(plain, new DecompressionStream('deflate-raw'), MAX_PLAIN);
	}
	return { kind: header.kind, payload: plain };
}

// ── Recovery code: the same container (kind 2), written as text ────────────────────────────

// Crockford base32, like the link codes: no I, L, O or U. Upper-case letters and digits also make
// the QR code use its compact alphanumeric mode.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUP = 5;

export function toBase32(bytes: Uint8Array): string {
	let out = '';
	let bits = 0;
	let acc = 0;
	for (const byte of bytes) {
		acc = (acc << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(acc >> (bits - 5)) & 31];
			bits -= 5;
		}
		acc &= (1 << bits) - 1;
	}
	if (bits) out += ALPHABET[(acc << (5 - bits)) & 31];
	return out;
}

/** Null when a character is outside the alphabet. */
export function fromBase32(text: string): Uint8Array | null {
	const out: number[] = [];
	let bits = 0;
	let acc = 0;
	for (const char of text) {
		const value = ALPHABET.indexOf(char);
		if (value < 0) return null;
		acc = (acc << 5) | value;
		bits += 5;
		if (bits >= 8) {
			out.push((acc >> (bits - 8)) & 255);
			bits -= 8;
		}
		acc &= (1 << bits) - 1;
	}
	return Uint8Array.from(out);
}

/** What a person types or a scanner reads: any case, dashes or spaces, O for 0, I or L for 1. */
export function normalizeRecoveryCode(input: string): string {
	return input
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, '')
		.replace(/O/g, '0')
		.replace(/[IL]/g, '1');
}

/** The container behind a recovery code, or null when the text is not one of ours. */
export function parseRecoveryCode(input: string): Uint8Array | null {
	const text = normalizeRecoveryCode(input);
	if (text.length < 100) return null;
	const bytes = fromBase32(text);
	if (!bytes) return null;
	try {
		return parseHeader(bytes).kind === KIND_KEY ? bytes : null;
	} catch {
		return null;
	}
}

/** Groups of five for reading and typing: `ABCDE-FGHJK-...`. The QR code carries the compact form. */
export function formatRecoveryCode(compact: string): string {
	return compact.match(new RegExp(`.{1,${GROUP}}`, 'g'))?.join('-') ?? compact;
}

/** Recovery code for a 32-byte secret: `compact` goes into the QR code, `grouped` is shown to read or type. */
export async function recoveryCode(secret: Uint8Array, passphrase: string, options?: SealOptions): Promise<{ compact: string; grouped: string }> {
	const compact = toBase32(await seal(KIND_KEY, secret, passphrase, options));
	return { compact, grouped: formatRecoveryCode(compact) };
}

/** Opens a recovery code. The secret is always exactly 32 bytes. */
export async function openRecoveryCode(input: string, passphrase: string): Promise<Uint8Array> {
	const bytes = parseRecoveryCode(input);
	if (!bytes) throw new BackupError('format');
	const { payload } = await open(bytes, passphrase);
	if (payload.length !== 32) throw new BackupError('format');
	return payload;
}

/** Strength hint for the passphrase field: 0 (too short) to 3. Length and variety only; no word lists. */
export function passphraseScore(passphrase: string): 0 | 1 | 2 | 3 {
	const chars = [...passphrase.normalize('NFKC')];
	if (chars.length < MIN_PASSPHRASE) return 0;
	const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(passphrase)).length;
	const unique = new Set(chars).size;
	const bits = chars.length * Math.log2(Math.max(2, Math.min(unique, 12 + classes * 14)));
	return bits >= 90 ? 3 : bits >= 60 ? 2 : 1;
}

/** 32 bytes from 64 hex characters, or null. For the plain key older versions copied to the clipboard. */
export function hexToBytesSafe(text: string): Uint8Array | null {
	const hex = text.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(hex)) return null;
	return Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));
}
