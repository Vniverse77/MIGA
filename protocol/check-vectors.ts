// Self-check: every stored vector must still be reproduced by the REAL web modules.
// 1. each ciphertext decrypts back to the stored plaintext / result;
// 2. each derived value (keys, addresses, numbers, validator outputs) is recomputed;
// 3. regenerating everything in memory gives byte-identical JSON (same test as the CI diff).
// Run: `deno task vectors:check` in web/.
// deno-lint-ignore-file no-explicit-any
import { build } from './gen-vectors.ts';
import { attach, crypto_ as C, devices, force, fromHex, hex, installDeterminism, openEnvelope, pairKey, sha256, utf8ToBytes } from './lib.ts';

installDeterminism();
const dir = new URL('./test-vectors/', import.meta.url);
const load = async (name: string): Promise<any> => JSON.parse(await Deno.readTextFile(new URL(name, dir)));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
let checks = 0;
const fails: string[] = [];
function ok(cond: boolean, what: string): void {
	checks++;
	if (!cond) fails.push(what);
}

// identity, auth, pair key, safety
for (const c of (await load('identity.json')).cases) {
	const id = C.identityFromSecret(fromHex(c.seed));
	ok(id.address === c.address, `identity ${c.name}`);
	ok(C.isAddress(c.address) === c.is_address, `identity valid ${c.name}`);
}
for (const c of (await load('auth.json')).cases) ok(C.signAuth(C.identityFromSecret(fromHex(c.seed)), c.nonce) === c.signature, 'auth sig');
for (const c of (await load('pair-key.json')).cases) ok(same(pairKey(c.seed, c.peer), { shared: c.shared, info: c.info, key: c.key }), 'pair key');
for (const c of (await load('safety.json')).cases) ok(C.safetyNumber(c.mine, c.theirs) === c.number, 'safety');

// envelopes: decrypt as the recipient, and open with the independently derived key
for (const file of ['envelope.json', 'envelope-raw.json']) {
	for (const c of (await load(file)).cases) {
		const me = C.identityFromSecret(fromHex(c.recipient_seed));
		ok(same(C.decrypt(me, c.sender, c.body), c.expect), `${file} ${c.name}: decrypt`);
		const key = pairKey(c.recipient_seed, c.sender).key;
		const o = openEnvelope(key, c.body);
		ok(o.plaintext === c.plaintext || c.name === 'no_padding_still_opens', `${file} ${c.name}: plaintext`);
		ok(o.nonce === c.nonce, `${file} ${c.name}: nonce`);
		if (c.name !== 'no_padding_still_opens') ok(o.paddedLen % 256 === 0, `${file} ${c.name}: padding multiple`);
		// the sender can read its own message too (same key)
		ok(same(C.decrypt(C.identityFromSecret(fromHex(c.sender_seed)), c.recipient, c.body), c.expect), `${file} ${c.name}: sender decrypt`);
	}
}
for (const c of (await load('envelope-negative.json')).cases) {
	ok(same(C.decrypt(C.identityFromSecret(fromHex(c.recipient_seed)), c.claimed_sender, c.body), c.expect), `negative ${c.name}`);
}
for (const c of (await load('padding.json')).cases) {
	const o = openEnvelope(pairKey((await load('identity.json')).cases[2].seed, (await load('identity.json')).cases[3].address).key, c.body);
	ok(utf8ToBytes(o.plaintext).length === c.json_bytes && o.paddedLen === c.padded_len && o.paddedLen === Math.ceil(c.json_bytes / 256) * 256, `padding ${c.filler} ${c.target_json_bytes}`);
}

// validators: re-run the real functions
const v = await load('validators.json');
for (const c of v.clean_edit) ok(same(C.cleanEdit(c.input), c.output), 'clean_edit');
for (const c of v.clean_reply) ok(same(C.cleanReply(c.input), c.output), 'clean_reply');
for (const c of v.clean_ids) ok(same(C.cleanIds(c.input), c.output), 'clean_ids');
for (const c of v.clean_att) ok(same(attach.cleanAtt(c.input, c.with_delete), c.output), `clean_att ${c.name}`);
for (const c of v.clean_name) ok(devices.cleanProfile({ name: c.input }).name === c.output, 'clean_name');
for (const c of v.normalize_link_code) ok(devices.normalizeLinkCode(c.input) === c.output, 'normalize_link_code');
for (const c of v.utf16_lengths) ok(c.text.length === c.utf16_units && [...c.text].length === c.code_points, 'utf16');
for (const c of (await load('address.json')).cases) ok(C.isAddress(c.input) === c.valid, `address ${c.name}`);

// link bundles and sync seals
for (const c of (await load('link.json')).cases) {
	const d = await devices.deriveLink(c.code);
	ok(hex(d.identity.secret) === c.mailbox_seed && d.identity.address === c.mailbox_address && hex(d.key) === c.bundle_key, 'link derive');
	ok(same(devices.open(d.key, c.body), c.bundle), 'link bundle open');
	ok(devices.open(d.key, c.body, 'x') === null && devices.open(sha256(d.key), c.body) === null, 'link bundle negatives');
}
const ss = await load('sync-seal.json');
const syncKey = devices.syncKey(C.identityFromSecret(fromHex(ss.account_seed)));
ok(hex(syncKey) === ss.sync_key, 'sync key');
for (const c of ss.cases) {
	ok(same(devices.open(syncKey, c.body, c.aad), c.value), `sync open ${c.name}`);
	ok(devices.open(syncKey, c.body, c.to + c.from) === null && devices.open(syncKey, c.body, '') === null, `sync wrong aad ${c.name}`);
}

// attachments: rebuild the plaintext, re-encrypt with the stored key/nonce, decrypt back
for (const c of (await load('file-chunks.json')).cases) {
	const plain = Uint8Array.from({ length: c.size }, (_, j) => (j * 131 + 17) % 251);
	force(c.key);
	force(c.base_nonce);
	const e = attach.encryptFile(plain);
	ok(hex(sha256(e.cipher)) === c.cipher_sha256 && e.hash === c.hash && e.cipher.length === c.cipher_len, `file ${c.size}: encrypt`);
	ok(hex(attach.decryptFile(e.cipher, { key: c.key, nonce: c.base_nonce, hash: c.hash, size: c.size })) === hex(plain), `file ${c.size}: decrypt`);
}

// everything regenerates byte for byte
const fresh = await build();
for (const [name, value] of Object.entries(fresh)) {
	ok(JSON.stringify(value, null, 2) + '\n' === await Deno.readTextFile(new URL(name, dir)), `regenerate ${name}`);
}

if (fails.length) {
	console.error(`FAILED ${fails.length} of ${checks} checks:\n  ` + [...new Set(fails)].slice(0, 30).join('\n  '));
	Deno.exit(1);
}
console.log(`ok: ${checks} checks`);
