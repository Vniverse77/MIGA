// Backup content: own photo and pins travel in the file, old files without them still load.
import assert from 'node:assert/strict';
(globalThis as Record<string, unknown>).__MIGA_TARGET__ = 'web';
const { buildBackup, cleanBackup, decodeBackup, encodeBackup } = await import('./backup-data.ts');
const { identityFromSecret, hexToBytes } = await import('./crypto.ts');

const secret = '11'.repeat(32);
const id = identityFromSecret(hexToBytes(secret));
const peer = identityFromSecret(hexToBytes('22'.repeat(32))).address;
const base = { profile: { name: 'Test Alpha', share: true }, contacts: [], blocked: [], muted: [], chats: {}, settings: { receipts: true, live: false, notify: 'name' as const } };

Deno.test('photo and pins round-trip through an encrypted backup', async () => {
	const data = { ...base, photo: { type: 'image/webp', data: 'QUJDRA==' }, pins: { m: { [peer]: ['mx1'] }, c: [peer] } };
	const bytes = await encodeBackup(buildBackup(id, data, { extras: true, history: false }), 'correct horse battery');
	const back = await decodeBackup(bytes, 'correct horse battery');
	assert.deepEqual(back.photo, data.photo);
	assert.deepEqual(back.pins, data.pins);
});

Deno.test('an old backup without photo or pins still loads', () => {
	const out = cleanBackup({ v: 1, created: 1, secret });
	assert.equal(out.photo, undefined);
	assert.equal(out.pins, undefined);
});

Deno.test('a bad photo in a backup is dropped, not trusted', () => {
	assert.equal(cleanBackup({ v: 1, created: 1, secret, photo: { type: 'text/html', data: 'QUJD' } }).photo, undefined);
	assert.equal(cleanBackup({ v: 1, created: 1, secret, photo: { type: 'image/png', data: '<script>' } }).photo, undefined);
});
