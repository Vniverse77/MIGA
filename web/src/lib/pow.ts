// Proof of work for first contact (hashcash style). See docs/PROTOCOL.md, "First contact".
//
// A sender that is not yet known to the receiver attaches `pow: {v, d, n}` inside the encrypted payload:
//   digest = SHA-256("miga-pow-v1:" + sender + ":" + recipient + ":" + d + ":" + n)
// and the digest must start with at least POW_BITS zero bits. `d` is the UTC day number (ms / 86 400 000),
// so one solution is good for one day and one recipient; it cannot be reused against another address.
// The relay never sees it (it is inside the ciphertext) and learns nothing new. It is a speed bump for
// bulk senders, not a proof of identity: it costs a phone a second or two per recipient per day and
// costs a spammer that much for every address it wants to reach.
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';

export const POW_VERSION = 1;
/** Required leading zero bits. 2^17 hashes on average: about 0.5 s on a desktop, roughly 1 to 3 s on a mid phone. */
export const POW_BITS = 17;
/** A solution is accepted for the day it was made and the days around it (clock skew, queued delivery). */
export const POW_DAY_SLACK = 1;
const DAY_MS = 86_400_000;
const MAX_NONCE = 2 ** 40;

export type Pow = { v: number; d: number; n: number };

export const powDay = (ms: number = Date.now()): number => Math.floor(ms / DAY_MS);

function prefix(sender: string, recipient: string, day: number): Uint8Array {
	return utf8ToBytes(`miga-pow-v1:${sender}:${recipient}:${day}:`);
}

/** True if the first `bits` bits of `digest` are zero. */
export function leadingZeroBits(digest: Uint8Array, bits: number): boolean {
	const whole = bits >> 3;
	for (let i = 0; i < whole; i++) if (digest[i] !== 0) return false;
	const rest = bits & 7;
	return rest === 0 || (digest[whole] >> (8 - rest)) === 0;
}

/** SHA-256 state after the fixed prefix; each nonce clones it instead of hashing the prefix again. */
function primed(base: Uint8Array) {
	return sha256.create().update(base);
}

function digestOf(base: ReturnType<typeof primed>, nonce: number): Uint8Array {
	return base.clone().update(utf8ToBytes(String(nonce))).digest();
}

/**
 * Looks for a nonce in [from, from + count). Returns it, or null if none of them works. Callers loop
 * with a growing `from`, so a worker (or a timer) can stop between slices.
 */
export function solveSlice(
	sender: string,
	recipient: string,
	day: number,
	from: number,
	count: number,
	bits: number = POW_BITS
): number | null {
	const base = primed(prefix(sender, recipient, day));
	for (let n = from; n < from + count && n < MAX_NONCE; n++) {
		if (leadingZeroBits(digestOf(base, n), bits)) return n;
	}
	return null;
}

/** Blocking solve for tests and small difficulties. The app uses solvePow (Web Worker). */
export function solveSync(sender: string, recipient: string, day: number, bits: number = POW_BITS): Pow {
	for (let from = 0; ; from += 20_000) {
		const n = solveSlice(sender, recipient, day, from, 20_000, bits);
		if (n !== null) return { v: POW_VERSION, d: day, n };
	}
}

/** Shape check for a payload field; returns null for anything that is not a well-formed token. */
export function cleanPow(value: unknown): Pow | null {
	const p = (value ?? {}) as Partial<Pow>;
	if (p.v !== POW_VERSION) return null;
	if (!Number.isSafeInteger(p.d) || !Number.isSafeInteger(p.n)) return null;
	if ((p.d as number) < 0 || (p.n as number) < 0 || (p.n as number) >= MAX_NONCE) return null;
	return { v: p.v, d: p.d as number, n: p.n as number };
}

/**
 * Does `pow` prove work from `sender` to `recipient`? `at` is the time the relay stamped on the
 * message (queued messages are checked against their own day, not today).
 */
export function verifyPow(
	pow: Pow | null | undefined,
	sender: string,
	recipient: string,
	at: number,
	bits: number = POW_BITS
): boolean {
	if (!pow || pow.v !== POW_VERSION) return false;
	if (Math.abs(pow.d - powDay(at)) > POW_DAY_SLACK) return false;
	return leadingZeroBits(digestOf(primed(prefix(sender, recipient, pow.d)), pow.n), bits);
}

// ── Async solving (Web Worker, with a timer fallback) ─────────────────────────────────

type Job = { sender: string; recipient: string; day: number; bits: number };
const SLICE = 4_000;

/** Same loop as the worker, but in slices on the main thread so the page stays responsive. */
function solveInSlices(job: Job): Promise<Pow> {
	return new Promise((resolve) => {
		let from = 0;
		const step = () => {
			const n = solveSlice(job.sender, job.recipient, job.day, from, SLICE, job.bits);
			if (n !== null) return resolve({ v: POW_VERSION, d: job.day, n });
			from += SLICE;
			setTimeout(step, 0);
		};
		step();
	});
}

/**
 * Solves in a Web Worker so the interface never freezes. Without Worker support (or if the worker
 * fails to load) it falls back to short slices on the main thread.
 */
export function solvePow(sender: string, recipient: string, day: number = powDay(), bits: number = POW_BITS): Promise<Pow> {
	const job: Job = { sender, recipient, day, bits };
	if (typeof Worker === 'undefined') return solveInSlices(job);
	return new Promise((resolve) => {
		let worker: Worker;
		try {
			worker = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' });
		} catch {
			return void solveInSlices(job).then(resolve);
		}
		let done = false;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			worker.terminate();
			fn();
		};
		worker.onmessage = (e: MessageEvent<number>) =>
			finish(() => resolve({ v: POW_VERSION, d: day, n: e.data }));
		worker.onerror = () => finish(() => void solveInSlices(job).then(resolve));
		worker.postMessage(job);
	});
}
