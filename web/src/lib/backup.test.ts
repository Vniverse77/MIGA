// Run with `deno task test`. Fixed vectors pin the byte format (docs/BACKUP.md); the rest checks behaviour.
import assert from 'node:assert/strict';
const assertEquals = (a: unknown, b: unknown, msg?: string) => assert.deepStrictEqual(a, b, msg);
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
	BackupError,
	DEFAULT_KDF,
	HEADER,
	KIND_FILE,
	KIND_KEY,
	MAX_KDF,
	formatRecoveryCode,
	fromBase32,
	normalizeRecoveryCode,
	open,
	openRecoveryCode,
	parseHeader,
	parseRecoveryCode,
	passphraseScore,
	recoveryCode,
	seal,
	toBase32
} from './backup.ts';

const PASS = 'correct horse battery staple';
const SALT = new Uint8Array(16).map((_, i) => i);
const NONCE = new Uint8Array(24).map((_, i) => 0x80 + i);
const SECRET = new Uint8Array(32).map((_, i) => i * 3 + 1);
const FAST = { logN: 12, r: 8, p: 1 };

const FILE_VECTOR =
	'4d494741010100010c0801000102030405060708090a0b0c0d0e0f808182838485868788898a8b8c8d8e8f9091929394959697a1575df32beddedeb719ec93f324577f16617c89080185fc2ac9f8394e78c86c6a4c8ad8';
const CODE_VECTOR =
	'9N4MEG8108002308040020G30G2GC1R81450P30D1R7R10C2GE28B1M7H24RN2WCHP78Z44HJA9S95CPJZDQ2B6V3K6E3TPXC28C7CVRBSNGABB9SS1EDKM7NVXA273PD8VKNP3TSFHAMVARYS8JYA8QFYD0JEG';

Deno.test('file vector: fixed salt and nonce give the documented bytes', async () => {
	const out = await seal(KIND_FILE, new TextEncoder().encode('{"v":1,"secret":"x"}'), PASS, {
		kdf: FAST,
		salt: SALT,
		nonce: NONCE,
		compress: false
	});
	assertEquals(bytesToHex(out), FILE_VECTOR);
	const opened = await open(hexToBytes(FILE_VECTOR), PASS);
	assertEquals(opened.kind, KIND_FILE);
	assertEquals(new TextDecoder().decode(opened.payload), '{"v":1,"secret":"x"}');
});

Deno.test('recovery code vector', async () => {
	const code = await recoveryCode(SECRET, PASS, { kdf: FAST, salt: SALT, nonce: NONCE });
	assertEquals(code.compact, CODE_VECTOR);
	assertEquals(code.grouped.replaceAll('-', ''), CODE_VECTOR);
	assertEquals(await openRecoveryCode(code.grouped, PASS), SECRET);
});

Deno.test('header: layout, default KDF parameters and limits', async () => {
	const out = await seal(KIND_KEY, SECRET, PASS, { kdf: FAST });
	assertEquals(out.length, HEADER + 32 + 16);
	const header = parseHeader(out);
	assertEquals(header.kind, KIND_KEY);
	assertEquals(header.kdf, FAST);
	assertEquals(DEFAULT_KDF, { logN: 16, r: 8, p: 2 });
	// A file may not ask for more than the limits, even with a valid tag.
	const hostile = out.slice();
	hostile[8] = MAX_KDF.logN + 1;
	assertEquals((await rejection(() => (async () => parseHeader(hostile))())).code, 'params');
});

Deno.test('wrong passphrase is a clear error, not a crash', async () => {
	const out = await seal(KIND_FILE, new Uint8Array([1, 2, 3]), PASS, { kdf: FAST });
	assertEquals((await rejection(() => open(out, 'wrong passphrase!'))).code, 'passphrase');
	assertEquals((await rejection(() => open(out, ''))).code, 'passphrase');
});

Deno.test('tampering with the header or the body is detected', async () => {
	const out = await seal(KIND_FILE, new Uint8Array([1, 2, 3]), PASS, { kdf: FAST });
	for (const at of [6, 11, 30, HEADER, out.length - 1]) {
		const bad = out.slice();
		bad[at] ^= 1;
		assertEquals((await rejection(() => open(bad, PASS))).code, 'passphrase', `byte ${at}`);
	}
	// The KDF cost is authenticated: lowering it fails instead of opening with a weaker key.
	const weak = out.slice();
	weak[8] = 11;
	assertEquals((await rejection(() => open(weak, PASS))).code, 'params');
});

Deno.test('not a backup, truncated, or another version', async () => {
	assertEquals((await rejection(() => open(new Uint8Array(200), PASS))).code, 'format');
	assertEquals((await rejection(() => open(new Uint8Array(3), PASS))).code, 'format');
	const out = await seal(KIND_FILE, new Uint8Array([9]), PASS, { kdf: FAST });
	const future = out.slice();
	future[4] = 2;
	assertEquals((await rejection(() => open(future, PASS))).code, 'version');
	assertEquals((await rejection(() => open(out.slice(0, out.length - 1), PASS))).code, 'passphrase');
});

Deno.test('compressed payloads round-trip and shrink', async () => {
	const payload = new TextEncoder().encode('hello miga '.repeat(2000));
	const out = await seal(KIND_FILE, payload, PASS, { kdf: FAST });
	assert.ok(out.length < payload.length / 4);
	assertEquals((await open(out, PASS)).payload, payload);
});

Deno.test('two backups of the same data differ (random salt and nonce)', async () => {
	const a = await seal(KIND_FILE, SECRET, PASS, { kdf: FAST });
	const b = await seal(KIND_FILE, SECRET, PASS, { kdf: FAST });
	assert.notEqual(bytesToHex(a), bytesToHex(b));
});

Deno.test('passphrase is NFKC-normalised', async () => {
	const out = await seal(KIND_KEY, SECRET, 'école secrete 12', { kdf: FAST });
	assertEquals((await open(out, 'école secrete 12')).payload, SECRET);
});

Deno.test('recovery code text handling', async () => {
	assertEquals(parseRecoveryCode(CODE_VECTOR)?.length, HEADER + 48);
	// typed by hand: lower case, spaces, dashes, O for 0, I or L for 1
	const sloppy = formatRecoveryCode(CODE_VECTOR).toLowerCase().replaceAll('-', ' ').replaceAll('0', 'o').replaceAll('1', 'l');
	assertEquals(normalizeRecoveryCode(sloppy), CODE_VECTOR);
	assertEquals(parseRecoveryCode(sloppy)?.length, HEADER + 48);
	assertEquals(parseRecoveryCode('hello world'), null);
	assertEquals(parseRecoveryCode('https://example.org/app/#to=' + '7'.repeat(64)), null);
	assertEquals(parseRecoveryCode(CODE_VECTOR.slice(0, 60)), null);
	assertEquals((await rejection(() => openRecoveryCode(CODE_VECTOR, 'nope nope nope'))).code, 'passphrase');
	// a file container is not accepted as a recovery code
	const file = await seal(KIND_FILE, SECRET, PASS, { kdf: FAST });
	assertEquals(parseRecoveryCode(toBase32(file)), null);
});

Deno.test('base32 round trip', () => {
	for (const n of [0, 1, 2, 5, 31, 98, 99]) {
		const bytes = crypto.getRandomValues(new Uint8Array(n));
		assertEquals(fromBase32(toBase32(bytes)), bytes);
	}
	assertEquals(fromBase32('U'), null);
});

Deno.test('passphrase score', () => {
	assertEquals(passphraseScore('short'), 0);
	assertEquals(passphraseScore('aaaaaaaaaaaa'), 1);
	assert.ok(passphraseScore('correct horse battery staple') >= 2);
	assertEquals(passphraseScore('Tr0ub4dor&3 plus four words here'), 3);
});

async function rejection(work: () => Promise<unknown>): Promise<BackupError> {
	try {
		await work();
	} catch (error) {
		assert.ok(error instanceof BackupError, String(error));
		return error;
	}
	throw new Error('expected a BackupError');
}
