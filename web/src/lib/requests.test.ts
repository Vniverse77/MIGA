import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1';
import { POW_BITS, POW_VERSION, cleanPow, leadingZeroBits, powDay, solveSync, verifyPow } from './pow.ts';
import { classify, needsPow } from './requests.ts';

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const C = 'c3'.repeat(32);
const NOW = Date.UTC(2026, 10, 20, 12);
const DAY = powDay(NOW);

Deno.test('leadingZeroBits counts whole and partial bytes', () => {
	assert(leadingZeroBits(Uint8Array.of(0, 0, 0x3f), 18));
	assertFalse(leadingZeroBits(Uint8Array.of(0, 0, 0x40), 18));
	assert(leadingZeroBits(Uint8Array.of(0, 0xff), 8));
	assertFalse(leadingZeroBits(Uint8Array.of(1), 8));
	assert(leadingZeroBits(Uint8Array.of(0xff), 0));
});

Deno.test('a solved proof verifies, only for its own sender, recipient and day', () => {
	const pow = solveSync(A, B, DAY, 12);
	assertEquals(pow.v, POW_VERSION);
	assert(verifyPow(pow, A, B, NOW, 12));
	assertFalse(verifyPow(pow, C, B, NOW, 12), 'other sender');
	assertFalse(verifyPow(pow, A, C, NOW, 12), 'other recipient');
	assertFalse(verifyPow({ ...pow, d: pow.d + 1 }, A, B, NOW, 12) && verifyPow({ ...pow, d: pow.d - 1 }, A, B, NOW, 12), 'other day');
});

Deno.test('a proof is valid for the day it was made, one day either side, not longer', () => {
	const pow = solveSync(A, B, DAY, 10);
	assert(verifyPow(pow, A, B, NOW + 86_400_000, 10));
	assert(verifyPow(pow, A, B, NOW - 86_400_000, 10));
	assertFalse(verifyPow(pow, A, B, NOW + 3 * 86_400_000, 10), 'stale');
});

Deno.test('difficulty: a proof for fewer bits is rejected at the real difficulty', () => {
	// Find one that works for 4 bits but not for POW_BITS (almost always the first hit).
	let n = 0;
	let pow = { v: POW_VERSION, d: DAY, n };
	while (verifyPow(pow, A, B, NOW, 4) === false || verifyPow(pow, A, B, NOW)) pow = { ...pow, n: ++n };
	assertFalse(verifyPow(pow, A, B, NOW));
	assert(POW_BITS >= 16 && POW_BITS <= 20);
});

Deno.test('solving at the real difficulty is quick enough (under 5 s here)', () => {
	const t = performance.now();
	const pow = solveSync(A, B, DAY);
	assert(performance.now() - t < 5000);
	assert(verifyPow(pow, A, B, NOW));
});

Deno.test('cleanPow rejects malformed tokens', () => {
	assertEquals(cleanPow({ v: 1, d: 5, n: 7 }), { v: 1, d: 5, n: 7 });
	for (const bad of [null, 'x', {}, { v: 2, d: 1, n: 1 }, { v: 1, d: -1, n: 1 }, { v: 1, d: 1.5, n: 1 }, { v: 1, d: 1, n: 2 ** 41 }, { v: 1, d: '1', n: 1 }]) {
		assertEquals(cleanPow(bad), null);
	}
});

Deno.test('classify: contacts, requests, old clients, bad and missing proof', () => {
	const good = solveSync(A, B, DAY, 17);
	const base = { from: A, me: B, ts: NOW, strict: false };
	assertEquals(classify({ ...base, contact: {}, pow: undefined }), 'contact');
	assertEquals(classify({ ...base, contact: undefined, pow: good }), 'request');
	assertEquals(classify({ ...base, contact: undefined, pow: undefined }), 'unverified');
	assertEquals(classify({ ...base, contact: undefined, pow: { ...good, n: good.n + 1 } }), 'filtered');
	assertEquals(classify({ ...base, strict: true, contact: undefined, pow: undefined }), 'filtered');
	assertEquals(classify({ ...base, strict: true, contact: { request: true }, pow: undefined }), 'request');
	assertEquals(classify({ ...base, contact: { request: true, unverified: true }, pow: undefined }), 'unverified');
	// A different sender's proof does not help.
	assertEquals(classify({ ...base, from: C, contact: undefined, pow: good }), 'filtered');
});

Deno.test('needsPow: until the peer has written once', () => {
	assert(needsPow(undefined));
	assert(needsPow([]));
	const mine = { id: '1', mine: true, text: 'hi', ts: 1, state: 'sent' as const };
	assert(needsPow([mine]));
	assertFalse(needsPow([mine, { ...mine, id: '2', mine: false, state: 'received' as const }]));
});

Deno.test('the proof travels inside the ciphertext and old payloads without one still open', async () => {
	const { newIdentity, encrypt, decrypt } = await import('./crypto.ts');
	const alice = newIdentity();
	const bob = newIdentity();
	const pow = solveSync(alice.address, bob.address, DAY, 10);
	const withPow = decrypt(bob, alice.address, encrypt(alice, bob.address, 'hi', undefined, undefined, undefined, pow));
	assertEquals(withPow?.pow, pow);
	assert(verifyPow(withPow?.pow, alice.address, bob.address, NOW, 10));
	const plain = decrypt(bob, alice.address, encrypt(alice, bob.address, 'hi'));
	assertEquals(plain?.text, 'hi');
	assertEquals(plain?.pow, undefined);
});
