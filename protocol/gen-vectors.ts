// Generates protocol/test-vectors/*.json from the REAL web/src/lib modules.
// Run: `deno task vectors` in web/ (see protocol/README.md). The output is deterministic;
// CI regenerates it and fails if `git diff protocol/test-vectors` is not empty.
// deno-lint-ignore-file no-explicit-any
import {
	NOW, PAD, attach, crypto_, devices, edwardsToMontgomeryPriv, edwardsToMontgomeryPub, ed25519, force, fromHex, hex, installDeterminism,
	openEnvelope, pairKey, refChunkNonce, resetRng, seedOf, sha256, sha512, sync, utf8ToBytes, xchacha20poly1305
} from './lib.ts';
import { scryptAsync } from '../web/scripts/vector-deps.ts';

const C = crypto_;
type J = Record<string, any>;

const ids = {
	alice: seedOf('alice'),
	bob: seedOf('bob'),
	carol: seedOf('carol')
};
const addr = (seed: string) => C.identityFromSecret(fromHex(seed)).address;
const ident = (seed: string) => C.identityFromSecret(fromHex(seed));
const A = addr(ids.alice), B = addr(ids.bob), CA = addr(ids.carol);

const nonceOf = (label: string) => hex(sha256(utf8ToBytes('miga-vectors-nonce/' + label))).slice(0, 48);
const hex32 = (label: string) => hex(sha256(utf8ToBytes('miga-vectors-id/' + label))).slice(0, 32);
const hex64 = (label: string) => hex(sha256(utf8ToBytes('miga-vectors-id/' + label)));

// ── identity / auth / pair key / safety ──────────────────────────────────────────────────

function identityVectors(): J {
	const seeds: [string, string][] = [
		['rfc8032-test1', '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'],
		['rfc8032-test2', '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'],
		['alice', ids.alice], ['bob', ids.bob], ['carol', ids.carol],
		['all-zero-seed', '00'.repeat(32)], ['all-ff-seed', 'ff'.repeat(32)]
	];
	return {
		note: 'address = Ed25519 public key (lowercase hex) of the 32-byte seed. x25519_secret is what noble edwardsToMontgomeryPriv returns (SHA-512(seed)[0..32], clamped); sha512_first32 is the same before clamping. x25519_public is edwardsToMontgomeryPub(address). rfc8032-* addresses are the RFC 8032 section 7.1 public keys.',
		cases: seeds.map(([name, seed]) => {
			const id = ident(seed);
			return {
				name, seed, address: id.address,
				sha512_first32: hex(sha512(fromHex(seed)).slice(0, 32)),
				x25519_secret: hex(edwardsToMontgomeryPriv(fromHex(seed))),
				x25519_public: hex(edwardsToMontgomeryPub(fromHex(id.address))),
				is_address: C.isAddress(id.address)
			};
		})
	};
}

function authVectors(): J {
	const nonces = [hex64('auth-nonce-1'), '00'.repeat(32), 'ff'.repeat(32)];
	return {
		note: 'sig = Ed25519(seed, utf8("miga-auth-v0:" + nonceHex)); the hex STRING of the nonce is signed, not its bytes.',
		cases: nonces.flatMap((nonce) => [ids.alice, ids.bob].map((seed) => ({
			seed, address: addr(seed), nonce,
			message: 'miga-auth-v0:' + nonce,
			signature: C.signAuth(ident(seed), nonce)
		})))
	};
}

function pairKeyVectors(): J {
	const pairs: [string, string][] = [[ids.alice, B], [ids.bob, A], [ids.alice, CA], [ids.carol, A], [ids.bob, CA]];
	return {
		note: 'shared = X25519(x25519_secret(me), x25519_public(peer)); key = HKDF-SHA256(ikm = shared, salt = "miga-v0", info = utf8(sort([me, peer]).join("")), 32). The key is the same in both directions.',
		cases: pairs.map(([seed, peer]) => ({ seed, address: addr(seed), peer, ...pairKey(seed, peer) }))
	};
}

function safetyVectors(): J {
	const pairs: [string, string][] = [[A, B], [B, A], [A, CA], [B, CA], [A.toUpperCase(), B]];
	return {
		note: 'SHA-512("MIGA-safety-v1" || 0x00 || lo || hi), lo/hi = the two 32-byte addresses sorted bytewise (both are lowercased first). number = 12 x 5 digits.',
		cases: pairs.map(([mine, theirs]) => ({
			mine, theirs, number: C.safetyNumber(mine, theirs), grouped: C.groupSafety(C.safetyNumber(mine, theirs))
		})),
		is_safety_number: ['0'.repeat(60), '1'.repeat(59), '1'.repeat(61), 'a'.repeat(60), '', ' ' + '1'.repeat(59)]
			.map((input) => ({ input, valid: C.isSafetyNumber(input) }))
			.concat([{ input: 12345 as any, valid: C.isSafetyNumber(12345) }])
	};
}

// ── envelopes ────────────────────────────────────────────────────────────────────────────

const att = () => ({
	blob: hex32('att-blob'), key: hex64('att-key'), nonce: nonceOf('att-base'), hash: hex64('att-hash'),
	mime: 'image/webp', size: 123456, w: 1600, h: 900, thumb: 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4', del: hex32('att-del')
});
const reply = () => ({ id: hex32('reply-target'), from: B, text: 'the quoted preview' });

/** JSON text of a plain message sized to exactly `target` UTF-8 bytes, using `filler` (any width) plus ASCII. */
function textForJsonBytes(target: number, filler: string): string {
	const base = utf8ToBytes(JSON.stringify({ v: 0, text: '', ts: NOW })).length;
	const w = utf8ToBytes(filler).length;
	const room = target - base;
	return filler.repeat(Math.floor(room / w)) + 'a'.repeat(room % w);
}

type Case = { name: string; note?: string; run: () => string };

function sealCases(): J {
	const sender = ident(ids.alice);
	const nonceFor = (name: string) => nonceOf('env/' + name);
	const long = 'x'.repeat(4100);
	const text = (name: string, t: string, ...rest: any[]): Case => ({ name, run: () => (C.encrypt as any)(sender, B, t, ...rest) });
	const cases: Case[] = [
		text('text_plain', 'hello world'),
		text('text_unicode', 'merhaba dünya 😀 ğüşiöç €'),
		text('text_newlines', 'line one\nline two\r\n\ttabbed "quoted" \\ backslash </script>'),
		text('text_name', 'hi', 'Alice'),
		text('text_reply', 'answering', undefined, reply()),
		text('text_name_reply', 'both', 'Alice B.', reply()),
		text('text_empty_name_ignored', 'no name key', ''),
		{ ...text('text_over_limit_4100', long), note: 'encrypt() has no length limit; the UI refuses text above 4000 UTF-16 units and decrypt() returns the full text (Messenger slices it later).' },
		text('att_caption', 'a caption', 'Alice', undefined, att()),
		text('att_no_caption', '', undefined, undefined, att()),
		text('att_reply', 'with reply', undefined, reply(), att()),
		{ name: 'delete_one', run: () => C.encryptDelete(sender, B, [hex32('del-1')]) },
		{ name: 'delete_dedup_invalid', note: 'cleanIds is applied by encrypt: duplicates and invalid ids vanish', run: () => C.encryptDelete(sender, B, [hex32('del-1'), hex32('del-1'), 'bad id!', 'ok_id-2'] as any) },
		{ name: 'delete_capped_at_50', note: '60 ids in, 50 out', run: () => C.encryptDelete(sender, B, Array.from({ length: 60 }, (_, i) => 'id' + i)) },
		{ name: 'edit', run: () => C.encryptEdit(sender, B, hex32('edit-target'), 'edited text', NOW + 5000) },
		{ name: 'edit_default_ts', run: () => C.encryptEdit(sender, B, 'abc_123', 'x') },
		{ name: 'ack', run: () => C.encryptReceipt(sender, B, 'ack', [hex32('r1'), hex32('r2')]) },
		{ name: 'seen', run: () => C.encryptReceipt(sender, B, 'seen', [hex32('r1')]) },
		{ name: 'ack_empty_is_unreadable', note: 'an ack with no valid id decrypts to null (message is acknowledged and dropped)', run: () => C.encryptReceipt(sender, B, 'ack', []) },
		{ name: 'live_text', run: () => C.encryptLive(sender, B, 'typing this right now') },
		{ name: 'live_cleared', run: () => C.encryptLive(sender, B, '') },
		{ name: 'live_over_limit', note: 'encryptLive slices to 4000 UTF-16 units', run: () => C.encryptLive(sender, B, 'y'.repeat(4100)) }
	];
	const out = cases.map((c) => {
		force(nonceFor(c.name));
		const body = c.run();
		const opened = openEnvelope(pairKey(ids.alice, B).key, body);
		return {
			name: c.name, ...(c.note ? { note: c.note } : {}), source: 'real', sender_seed: ids.alice, sender: A, recipient_seed: ids.bob, recipient: B,
			nonce: opened.nonce, plaintext: opened.plaintext, padded_len: opened.paddedLen, body,
			expect: C.decrypt(ident(ids.bob), A, body)
		};
	});
	return { note: 'Every body is base64(nonce24 || XChaCha20-Poly1305(pairKey, nonce, padded JSON)), no AAD. `plaintext` is the JSON before padding; `expect` is what decrypt(recipient, sender, body) returns (null = unreadable).', cases: out };
}

/** Hand-crafted plaintexts (raw JSON) sealed with the pair key: they probe decrypt()'s leniency. */
function rawCases(): J {
	const key = pairKey(ids.alice, B).key;
	const seal = (json: string, nonce: string) => {
		const bytes = utf8ToBytes(json);
		const padded = new Uint8Array(Math.ceil(bytes.length / PAD) * PAD).fill(0x20);
		padded.set(bytes);
		const sealed = xchacha20poly1305(fromHex(key), fromHex(nonce)).encrypt(padded);
		const raw = new Uint8Array(24 + sealed.length);
		raw.set(fromHex(nonce));
		raw.set(sealed, 24);
		return C.toBase64(raw);
	};
	const cases: [string, string, string?][] = [
		['v_missing', '{"text":"hi","ts":1}'],
		['v_1', '{"v":1,"text":"hi","ts":1}'],
		['v_string_0', '{"v":"0","text":"hi","ts":1}'],
		['not_json', 'hello'],
		['json_array', '[1,2,3]'],
		['text_number', '{"v":0,"text":5,"ts":1}'],
		['ts_string_number', '{"v":0,"text":"hi","ts":"1234"}'],
		['ts_float', '{"v":0,"text":"hi","ts":1700000000000.5}'],
		['ts_missing', '{"v":0,"text":"hi"}', 'falls back to Date.now()'],
		['ts_zero', '{"v":0,"text":"hi","ts":0}'],
		['ts_garbage', '{"v":0,"text":"hi","ts":"soon"}'],
		['unknown_fields_ignored', '{"v":0,"text":"hi","ts":1,"future":{"a":1},"x":[1]}'],
		['name_not_string', '{"v":0,"text":"hi","ts":1,"name":5}'],
		['name_not_cleaned_by_decrypt', '{"v":0,"text":"hi","ts":1,"name":"  spaced   name  "}', 'clients clean the name later (ensureContact)'],
		['text_and_del_is_ordinary', '{"v":0,"text":"hi","ts":1,"del":["abc"]}'],
		['del_beats_edit', '{"v":0,"ts":1,"del":["abc"],"edit":{"id":"abc","text":"x"}}'],
		['edit_beats_live', '{"v":0,"ts":1,"edit":{"id":"abc","text":"x"},"live":{"text":"y"}}'],
		['live_beats_ack', '{"v":0,"ts":1,"live":{"text":"y"},"ack":["a"]}'],
		['ack_and_seen', '{"v":0,"ts":1,"ack":["a","b"],"seen":["c"]}'],
		['live_not_object', '{"v":0,"ts":1,"live":"typing"}'],
		['edit_empty_text', '{"v":0,"ts":1,"edit":{"id":"abc","text":"   "}}'],
		['edit_text_4001', '{"v":0,"ts":1,"edit":{"id":"abc","text":"' + 'a'.repeat(4001) + '"}}'],
		['edit_text_trimmed', '{"v":0,"ts":1,"edit":{"id":"abc","text":"\\u00a0\\ufeff trimmed \\u2003"}}'],
		['att_invalid_dropped', '{"v":0,"text":"x","cap":"c","ts":1,"att":{"blob":"nope"}}'],
		['att_null_is_invalid', '{"v":0,"text":"x","ts":1,"att":null}'],
		['att_cap_over_limit_sliced', JSON.stringify({ v: 0, text: 'p', cap: 'c'.repeat(4005), ts: 1, att: { blob: hex32('att-blob'), key: hex64('att-key'), nonce: nonceOf('att-base'), hash: hex64('att-hash'), mime: 'image/png', size: 10, w: 2, h: 2 } })],
		['att_cap_missing_means_empty', JSON.stringify({ v: 0, text: 'fallback text', ts: 1, att: { blob: hex32('att-blob'), key: hex64('att-key'), nonce: nonceOf('att-base'), hash: hex64('att-hash'), mime: 'image/png', size: 10, w: 2, h: 2 } })],
		['reply_invalid_dropped_message_kept', '{"v":0,"text":"hi","ts":1,"reply":{"id":"bad id","from":"zz","text":"q"}}'],
		['trailing_spaces_only_padding', '{"v":0,"text":"ends with spaces   ","ts":1}'],
		['no_padding_still_opens', '{"v":0,"text":"hi","ts":1}', 'sealed WITHOUT padding (non-multiple of 256); decrypt does not require padding']
	];
	return {
		note: 'Raw plaintexts sealed with the pair key (alice -> bob). They show what a lenient receiver must accept or drop. `expect` comes from the real decrypt().',
		cases: cases.map(([name, json, note], i) => {
			const nonce = nonceOf('raw/' + name);
			let body: string;
			if (name === 'no_padding_still_opens') {
				const sealed = xchacha20poly1305(fromHex(key), fromHex(nonce)).encrypt(utf8ToBytes(json));
				const raw = new Uint8Array(24 + sealed.length);
				raw.set(fromHex(nonce));
				raw.set(sealed, 24);
				body = C.toBase64(raw);
			} else body = seal(json, nonce);
			void i;
			return {
				name, ...(note ? { note } : {}), source: 'raw', sender_seed: ids.alice, sender: A, recipient_seed: ids.bob, recipient: B, nonce,
				plaintext: json, body, expect: C.decrypt(ident(ids.bob), A, body)
			};
		})
	};
}

function negativeCases(): J {
	const sender = ident(ids.alice);
	force(nonceOf('neg/base'));
	const body = C.encrypt(sender, B, 'secret');
	const flip = (b: string, at: number) => {
		const raw = C.fromBase64(b);
		raw[at] ^= 1;
		return C.toBase64(raw);
	};
	const raw = C.fromBase64(body);
	const wrongPeerBody = body;
	const list: [string, string, string, string][] = [
		['valid_control', body, A, B],
		['flip_nonce_bit', flip(body, 0), A, B],
		['flip_ciphertext_bit', flip(body, 30), A, B],
		['flip_tag_bit', flip(body, raw.length - 1), A, B],
		['truncated_tag', C.toBase64(raw.subarray(0, raw.length - 1)), A, B],
		['too_short_for_nonce', C.toBase64(raw.subarray(0, 10)), A, B],
		['empty_body', '', A, B],
		['not_base64', '!!!not base64!!!', A, B],
		['wrong_claimed_sender', wrongPeerBody, CA, B],
		['wrong_recipient', wrongPeerBody, A, CA]
	];
	return {
		note: 'decrypt(me = recipient, peer = claimed sender, body). A wrong peer changes the pair key, so it fails. `recipient` says which seed opens it.',
		cases: list.map(([name, b, peerAddr, recipient]) => ({
			name, body: b, claimed_sender: peerAddr,
			recipient_seed: recipient === B ? ids.bob : ids.carol,
			expect: C.decrypt(ident(recipient === B ? ids.bob : ids.carol), peerAddr, b)
		}))
	};
}

function paddingVectors(): J {
	const rows: J[] = [];
	const fillers: [string, string][] = [['ascii', 'a'], ['2byte', 'é'], ['3byte', '€'], ['4byte', '😀']];
	for (const [fname, filler] of fillers) {
		for (const target of [200, 255, 256, 257, 300, 511, 512, 513, 1023, 1024, 1025]) {
			const t = textForJsonBytes(target, filler);
			force(nonceOf(`pad/${fname}/${target}`));
			const body = C.encrypt(ident(ids.alice), B, t);
			const o = openEnvelope(pairKey(ids.alice, B).key, body);
			rows.push({ filler: fname, target_json_bytes: target, json_bytes: utf8ToBytes(o.plaintext).length, padded_len: o.paddedLen, body_base64_len: body.length, nonce: o.nonce, text: t, body });
		}
	}
	return { note: 'padded_len = ceil(json_bytes / 256) * 256 over UTF-8 BYTES, filled with 0x20. A JSON length of exactly 256 gets NO extra block. body = base64(24 + padded_len + 16 bytes).', cases: rows };
}

// ── validators ───────────────────────────────────────────────────────────────────────────

function addressVectors(): J {
	const validFromSeeds = ['alice', 'bob', 'carol', 'dave', 'erin'].map((n) => addr(seedOf(n)));
	// Little-endian y coordinates (hex) of points with small order and of non-canonical encodings.
	const special: [string, string][] = [
		['identity_y1', '01' + '00'.repeat(31)],
		['order2_y_minus1', 'ec' + 'ff'.repeat(30) + '7f'],
		['order4_y0', '00'.repeat(32)],
		['order4_y0_sign', '00'.repeat(31) + '80'],
		['order8_a', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'],
		['order8_a_sign', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa'],
		['order8_b', '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'],
		['order8_b_sign', '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85'],
		['noncanonical_y_eq_p', 'ed' + 'ff'.repeat(30) + '7f'],
		['noncanonical_y_eq_p_plus_1', 'ee' + 'ff'.repeat(30) + '7f'],
		['noncanonical_y_eq_p_plus_2', 'ef' + 'ff'.repeat(30) + '7f'],
		['all_ff', 'ff'.repeat(32)],
		['y_2', '02' + '00'.repeat(31)],
		['y_3', '03' + '00'.repeat(31)],
		['y_4', '04' + '00'.repeat(31)],
		['y_5', '05' + '00'.repeat(31)],
		['y_6', '06' + '00'.repeat(31)]
	];
	const stream = Array.from({ length: 8 }, (_, i) => hex64('addr-random-' + i));
	const text: [string, string][] = [
		['uppercase', validFromSeeds[0].toUpperCase()],
		['mixed_case', validFromSeeds[0].slice(0, 32).toUpperCase() + validFromSeeds[0].slice(32)],
		['63_chars', validFromSeeds[0].slice(1)],
		['65_chars', validFromSeeds[0] + '0'],
		['empty', ''],
		['with_0x_prefix', '0x' + validFromSeeds[0].slice(2)],
		['trailing_space', validFromSeeds[0] + ' '],
		['leading_space', ' ' + validFromSeeds[0]],
		['non_hex_g', 'g' + validFromSeeds[0].slice(1)],
		['newline', validFromSeeds[0] + '\n'],
		['fullwidth_digits', '０'.repeat(64)]
	];
	const mk = (kind: string, name: string, input: string) => ({ kind, name, input, valid: C.isAddress(input) });
	return {
		note: 'isAddress(input): 64 lowercase hex chars AND a successful X25519 key agreement with the converted key (rejects off-curve, low-order and non-canonical encodings in the way noble does). The relay accepts ANY 64 lowercase hex address; only clients check the curve.',
		cases: [
			...validFromSeeds.map((a, i) => mk('derived_from_seed', 'seed_' + i, a)),
			...special.map(([n, a]) => mk('special_point', n, a)),
			...stream.map((a, i) => mk('random_32_bytes', 'random_' + i, a)),
			...text.map(([n, a]) => mk('text_form', n, a))
		]
	};
}

const SPACES = (() => {
	const out: number[] = [];
	for (let c = 0; c <= 0xffff; c++) if (String.fromCharCode(c).trim() === '' && !(c >= 0xd800 && c <= 0xdfff)) out.push(c);
	return out;
})();

function validatorVectors(): J {
	const A1 = hex32('aid');
	const edit = (value: unknown) => ({ input: value, output: C.cleanEdit(value) });
	const ws = ' ﻿  　\t\n\r\v\f      ';
	const editCases = [
		{ id: 'abc', text: 'hello' }, { id: 'abc', text: '  hello  ' }, { id: 'abc', text: '' }, { id: 'abc', text: '   ' }, { id: 'abc', text: ws },
		{ id: 'abc', text: ws + 'x' + ws }, { id: 'abc', text: '\u0085x\u0085' }, { id: 'abc', text: '​x​' }, { id: 'abc', text: '᠎x' },
		{ id: 'abc', text: 'a'.repeat(4000) }, { id: 'abc', text: 'a'.repeat(4001) },
		{ id: 'abc', text: 'a'.repeat(4000) + ' ' }, { id: 'abc', text: ' ' + 'a'.repeat(3999) },
		{ id: 'abc', text: '😀'.repeat(2000) }, { id: 'abc', text: '😀'.repeat(2001) },
		{ id: 'abc', text: 'a' + '😀'.repeat(1999) + 'a' },
		{ id: 'bad id', text: 'x' }, { id: '', text: 'x' }, { id: 'a'.repeat(64), text: 'x' }, { id: 'a'.repeat(65), text: 'x' }, { id: 5, text: 'x' }, { id: 'abc', text: 5 },
		null, 'string', [], {}
	].map(edit);
	const replyCases = [
		{ id: 'abc', from: B, text: 'short' },
		{ id: 'abc', from: B, text: '  first line\nsecond line  ' },
		{ id: 'abc', from: B, text: 'win\r\nline' },
		{ id: 'abc', from: B, text: '\n\nleading blanks\nnext' },
		{ id: 'abc', from: B, text: '\n' },
		{ id: 'abc', from: B, text: '   ' },
		{ id: 'abc', from: B, text: 'a'.repeat(120) },
		{ id: 'abc', from: B, text: 'a'.repeat(121) },
		{ id: 'abc', from: B, text: 'a'.repeat(119) + '😀😀' },
		{ id: 'abc', from: B, text: '😀'.repeat(120) },
		{ id: 'abc', from: B, text: '😀'.repeat(121) },
		{ id: 'abc', from: B, text: 'é'.repeat(100) },
		{ id: 'abc', from: B, text: 'a'.repeat(1999) + '😀' + 'tail' },
		{ id: 'abc', from: B, text: '\n'.repeat(1999) + 'late line' },
		{ id: 'abc', from: B, text: ' '.repeat(2000) + 'after the cut' },
		{ id: 'abc', from: B.toUpperCase(), text: 'x' },
		{ id: 'abc', from: '00'.repeat(32), text: 'x' },
		{ id: 'abc', from: B, text: 5 }, { id: 'bad id', from: B, text: 'x' }, null
	].map((value) => ({ input: value, output: C.cleanReply(value) }));
	const idsCases = [
		['a', 'b'], ['a', 'a', 'b'], ['bad id', 'ok_1-2'], [5, null, 'x'], 'notarray', [], null,
		Array.from({ length: 60 }, (_, i) => 'id' + i), ['a'.repeat(64), 'a'.repeat(65), '']
	].map((value) => ({ input: value, output: C.cleanIds(value) }));
	const goodAtt = { blob: hex32('b'), key: hex64('k'), nonce: nonceOf('n'), hash: hex64('h'), mime: 'image/png', size: 100, w: 10, h: 20, thumb: 'data:image/webp;base64,AAAA', del: hex32('d') };
	const attVariants: [string, any, boolean?][] = [
		['good', goodAtt], ['good_with_delete_allowed', goodAtt, true], ['no_thumb', { ...goodAtt, thumb: undefined }],
		['bad_thumb_dropped', { ...goodAtt, thumb: 'http://x/y.png' }], ['thumb_too_long', { ...goodAtt, thumb: 'data:image/png;base64,' + 'A'.repeat(4001) }],
		['blob_short', { ...goodAtt, blob: 'abc' }], ['blob_upper', { ...goodAtt, blob: goodAtt.blob.toUpperCase() }],
		['key_63', { ...goodAtt, key: goodAtt.key.slice(1) }], ['nonce_is_32_hex', { ...goodAtt, nonce: hex32('n') }],
		['hash_upper', { ...goodAtt, hash: goodAtt.hash.toUpperCase() }],
		['mime_svg', { ...goodAtt, mime: 'image/svg+xml' }], ['mime_heic', { ...goodAtt, mime: 'image/heic' }], ['mime_mp4', { ...goodAtt, mime: 'video/mp4' }], ['mime_webm', { ...goodAtt, mime: 'video/webm' }], ['mime_audio', { ...goodAtt, mime: 'audio/mpeg' }],
		['size_0', { ...goodAtt, size: 0 }], ['size_1', { ...goodAtt, size: 1 }], ['size_25mib', { ...goodAtt, size: 25 * 1024 * 1024 }], ['size_25mib_plus1', { ...goodAtt, size: 25 * 1024 * 1024 + 1 }],
		['size_string_number', { ...goodAtt, size: '100' }], ['size_float', { ...goodAtt, size: 10.5 }],
		['w_float_rounds', { ...goodAtt, w: 3.6, h: 4.4 }], ['w_zero', { ...goodAtt, w: 0 }], ['w_20000', { ...goodAtt, w: 20000 }], ['w_20001', { ...goodAtt, w: 20001 }], ['w_half_rounds_to_zero', { ...goodAtt, w: 0.4 }],
		['del_bad', { ...goodAtt, del: 'zz' }, true], ['null', null], ['string', 'x']
	];
	const attCases = attVariants.map(([name, value, withDelete]) => ({ name, with_delete: !!withDelete, input: value, output: attach.cleanAtt(value, withDelete) }));
	const nameCases = ['Alice', '  Alice  ', 'A  B\t\nC', '', '   ', 'x'.repeat(40), 'x'.repeat(41), 'x'.repeat(39) + '😀', ' ﻿Name　', 'a\u0085b', 5, null]
		.map((value) => ({ input: value, output: devices.cleanProfile({ name: value }).name }));
	const linkCodes = ['abcd-efgh-jkmn', 'ABCDEFGHJKMN', '0123 4567 89AB', 'OIL0-OIL0-OIL0', 'oooo-iiii-llll', 'ABCD-EFGH-JKMU', 'ABCDEFGHJKM', 'ABCDEFGHJKMNP', '', 'ab_cd.ef/gh ij*kn', 'ＡBCDEFGHJKMN', 'abcdéefghjkmn', 'ABCD\nEFGH\tJKMN', 'ILIL-ILIL-ILIL', '1234-5678-9ABZ', 'uuuu-uuuu-uuuu']
		.map((input) => ({ input, output: devices.normalizeLinkCode(input) }));
	const editTimes = [[5, 100], [0, 100], [-5, 100], ['abc', 100], [undefined, 100], [null, 100], [100 + 86_400_000, 100], [100 + 86_400_000 + 1, 100], ['150', 100], [Infinity, 100], [1.5, 100]]
		.map(([ts, now]) => ({ ts: ts === Infinity ? 'Infinity' : ts, now, output: C.editTime(ts, now as number) }));
	const applyEdits = [
		{ name: 'first_edit', list: [{ id: 'm1', mine: false, text: 'old', ts: 1, state: 'received' }], edit: { id: 'm1', mine: false, text: ' new ', ts: 1000 } },
		{ name: 'same_ts_ignored', list: [{ id: 'm1', mine: false, text: 'x', ts: 1, state: 'received', edited: 1000 }], edit: { id: 'm1', mine: false, text: 'y', ts: 1000 } },
		{ name: 'older_ts_ignored', list: [{ id: 'm1', mine: false, text: 'x', ts: 1, state: 'received', edited: 1000 }], edit: { id: 'm1', mine: false, text: 'y', ts: 999 } },
		{ name: 'newer_wins', list: [{ id: 'm1', mine: false, text: 'x', ts: 1, state: 'received', edited: 1000 }], edit: { id: 'm1', mine: false, text: 'y', ts: 1001 } },
		{ name: 'wrong_owner_ignored', list: [{ id: 'm1', mine: true, text: 'x', ts: 1, state: 'sent' }], edit: { id: 'm1', mine: false, text: 'y', ts: 1000 } },
		{ name: 'unknown_id', list: [{ id: 'm1', mine: false, text: 'x', ts: 1, state: 'received' }], edit: { id: 'm2', mine: false, text: 'y', ts: 1000 } },
		{ name: 'same_text_still_bumps_edited', list: [{ id: 'm1', mine: false, text: 'x', ts: 1, state: 'received' }], edit: { id: 'm1', mine: false, text: 'x', ts: 1000 } },
		{ name: 'future_ts_clamped_to_now_plus_1_day', list: [{ id: 'm1', mine: false, text: 'x', ts: 1, state: 'received' }], edit: { id: 'm1', mine: false, text: 'y', ts: NOW * 3 } },
		{ name: 'empty_text_rejected', list: [{ id: 'm1', mine: false, text: 'x', ts: 1, state: 'received' }], edit: { id: 'm1', mine: false, text: '  ', ts: 1000 } }
	].map((c) => {
		const list = structuredClone(c.list);
		const changed = C.applyEdit(list as any, c.edit);
		return { ...c, returns: changed, list_after: list };
	});
	const utf16 = ['', 'a', 'é', '€', '😀', '👨‍👩‍👧', '🇹🇷', 'é', '\ud83d', 'a\ude00', 'a'.repeat(4000), '😀'.repeat(2000), '😀'.repeat(2000) + 'a']
		.map((text) => ({
			text, utf16_units: text.length, code_points: [...text].length, utf8_bytes: utf8ToBytes(text).length,
			over_max_text_4000: text.length > C.MAX_TEXT
		}));
	return {
		note: 'Outputs come from the real functions. `output: null` = rejected. Strings may contain lone surrogates (escaped \\udXXX in the JSON); a Rust port must treat the cases that contain them as UTF-16 sequences (or skip them, see README).',
		constants: { MAX_TEXT: C.MAX_TEXT, MAX_DELETE: C.MAX_DELETE, REPLY_PREVIEW: C.REPLY_PREVIEW, ATT_PLACEHOLDER: C.ATT_PLACEHOLDER, CHUNK: attach.CHUNK, MAX_ATTACHMENT: attach.MAX_ATTACHMENT, LINK_TTL_MS: devices.LINK_TTL_MS },
		js_whitespace_code_units: SPACES,
		utf16_lengths: utf16,
		clean_edit: editCases,
		clean_reply: replyCases,
		clean_ids: idsCases,
		clean_att: attCases,
		clean_name: nameCases,
		normalize_link_code: linkCodes,
		edit_time: editTimes,
		apply_edit: applyEdits,
		_unused: A1 && undefined
	};
}

// ── link code, link bundle, sync seal ────────────────────────────────────────────────────

async function linkVectors(): Promise<J> {
	const codes: J[] = [];
	for (let i = 0; i < 3; i++) {
		const bytes = sha256(utf8ToBytes('miga-vectors-link/' + i)).slice(0, 12);
		force(bytes);
		const code = devices.newLinkCode();
		const out = await scryptAsync(utf8ToBytes(code), utf8ToBytes('miga-link-v0'), { N: 2 ** 15, r: 8, p: 1, dkLen: 64 });
		const derived = await devices.deriveLink(code);
		if (hex(derived.identity.secret) !== hex(out.slice(0, 32)) || hex(derived.key) !== hex(out.slice(32))) throw new Error('deriveLink disagrees with scrypt');
		const bundle = {
			k: 'link', secret: ids.alice, sponsor: addr(seedOf('device-' + i)), exp: NOW + devices.LINK_TTL_MS,
			profile: { name: i === 1 ? '' : 'Alice', share: i !== 2 },
			devices: [{ address: addr(seedOf('device-' + i)), label: 'Linux · MIGA CLI', added: NOW - 1000 }]
		};
		force(nonceOf('bundle/' + i));
		const body = devices.seal(derived.key, bundle);
		const opened = openEnvelope(hex(derived.key), body);
		codes.push({
			random_bytes: hex(bytes), code, grouped: devices.formatLinkCode(code), scrypt_out: hex(out),
			mailbox_seed: hex(derived.identity.secret), mailbox_address: derived.identity.address, bundle_key: hex(derived.key),
			bundle, nonce: opened.nonce, plaintext: opened.plaintext, padded_len: opened.paddedLen, body,
			open_ok: devices.open(derived.key, body),
			open_with_other_key: devices.open(sha256(derived.key), body),
			open_with_aad: devices.open(derived.key, body, 'x')
		});
	}
	return {
		note: 'code (12 Crockford base32 chars from `byte & 31`) -> scrypt(utf8(code), "miga-link-v0", N=2^15, r=8, p=1, 64) -> [0..32] mailbox seed, [32..64] bundle key. Bundle = same sealed format as messages but with NO pair key and NO AAD. The new device must also reject a bundle whose exp has passed (not part of open()).',
		alphabet: '0123456789ABCDEFGHJKMNPQRSTVWXYZ',
		cases: codes
	};
}

function syncSealVectors(): J {
	const account = ident(ids.alice);
	const key = devices.syncKey(account);
	const d1 = addr(seedOf('device-1')), d2 = addr(seedOf('device-2'));
	const cursor = { c: B, t: NOW, i: 'm9' };
	const message = { id: 'm1', mine: false, text: 'hello 😀', ts: NOW, state: 'received' };
	const msgs: [string, any][] = [
		['hello', { k: 'hello', label: 'Linux · MIGA CLI', sponsor: d2 }],
		['state_profile_devices', { k: 'state', profile: { name: 'Alice', share: true }, devices: [{ address: d2, label: 'Phone', added: NOW }] }],
		['state_contacts', { k: 'state', contacts: [{ address: B, name: 'Bob', custom: true, verified: C.safetyNumber(A, B) }] }],
		['state_blocked', { k: 'state', blocked: [CA] }],
		['msg_text', { k: 'msg', peer: B, message, name: 'Bob' }],
		['msg_att_mine', { k: 'msg', peer: B, message: { id: 'm2', mine: true, text: '', ts: NOW, state: 'sent', delivery: 'read', att: att() } }],
		['hxq_first', { k: 'hxq', sid: 's1', q: 'q1', after: null }],
		['hxq_cursor', { k: 'hxq', sid: 's1', q: 'q2', after: cursor }],
		['hx_page', { k: 'hx', sid: 's1', q: 'q2', chats: { [B]: [message] }, next: cursor, total: 7 }],
		['tomb', { k: 'tomb', items: [{ c: B, s: 'm', id: 'm1', mine: false, ts: NOW }, { c: CA, s: 'k', ts: NOW }] }],
		['read', { k: 'read', peer: B, upTo: NOW }],
		['edit', { k: 'edit', peer: B, id: 'm1', mine: false, text: 'edited', ts: NOW + 1 }],
		['st', { k: 'st', peer: B, ids: ['m1'], d: 'delivered' }],
		['receipts', { k: 'receipts', on: true }],
		['bye', { k: 'bye', address: d1 }]
	];
	return {
		note: 'Sync messages between devices of one account. key = HKDF-SHA256(ikm = account seed (32 bytes), salt "miga-v0", info "sync", 32). Body = base64(nonce || XChaCha20-Poly1305(key, nonce, padded JSON, aad = utf8(senderDevice + recipientDevice))). The JSON in `plaintext` is exactly what JSON.stringify produced (key order = construction order; receivers must not depend on it).',
		account_seed: ids.alice, account_address: A, sync_key: hex(key),
		device_1: d1, device_2: d2,
		cases: msgs.flatMap(([name, value]) => {
			force(nonceOf('sync/' + name));
			const aad = d1 + d2;
			const body = devices.seal(key, value, aad);
			const opened = openEnvelope(hex(key), body, aad);
			return [{
				name, from: d1, to: d2, aad, value, nonce: opened.nonce, plaintext: opened.plaintext, padded_len: opened.paddedLen, body,
				open_ok: devices.open(key, body, aad),
				open_swapped_aad: devices.open(key, body, d2 + d1),
				open_empty_aad: devices.open(key, body, ''),
				open_wrong_key: devices.open(sha256(key), body, aad)
			}];
		})
	};
}

// ── sync helpers (merge / history / tombstones) ──────────────────────────────────────────

function syncLogicVectors(): J {
	const m = (id: string, mine: boolean, ts: number, extra: J = {}) => ({ id, mine, text: id, ts, state: mine ? 'sent' : 'received', ...extra });
	const merge = [
		{ name: 'add_new_sorted', list: [m('a', false, 10), m('c', false, 30)], incoming: [m('b', true, 20)] },
		{ name: 'same_id_different_side_are_two', list: [m('a', false, 10)], incoming: [m('a', true, 10)] },
		{ name: 'newer_edit_wins', list: [m('a', false, 10, { edited: 5, text: 'old' })], incoming: [m('a', false, 10, { edited: 9, text: 'new' })] },
		{ name: 'older_edit_ignored', list: [m('a', false, 10, { edited: 9, text: 'new' })], incoming: [m('a', false, 10, { edited: 5, text: 'old' })] },
		{ name: 'delivery_only_forward', list: [m('a', true, 10, { delivery: 'read' })], incoming: [m('a', true, 10, { delivery: 'delivered' })] },
		{ name: 'delivery_advances', list: [m('a', true, 10)], incoming: [m('a', true, 10, { delivery: 'delivered' })] },
		{ name: 'delivery_ignored_for_received', list: [m('a', false, 10)], incoming: [m('a', false, 10, { delivery: 'read' })] }
	].map((c) => {
		const list = structuredClone(c.list);
		const added = sync && devices.mergeMessages(list as any, structuredClone(c.incoming) as any);
		return { ...c, returns_added: added, list_after: list };
	});
	const chats: any = {
		[B]: [m('b3', false, 30), m('b1', true, 10), m('b2', false, 10), m('b2', true, 10)],
		[CA]: [m('c1', false, 5), m('c2', true, 6)]
	};
	const pages: J[] = [];
	let after: any = null;
	for (let i = 0; i < 20; i++) {
		const page = sync.historyPage(chats, after, 250);
		pages.push({ after, ...page });
		if (!page.next) break;
		after = page.next;
	}
	const tombs: any[] = [];
	const steps = [
		[{ c: B, s: 'm', id: 'x', mine: false, ts: 100 }],
		[{ c: B, s: 'm', id: 'x', mine: false, ts: 90 }],
		[{ c: B, s: 'm', id: 'x', mine: false, ts: 110 }, { c: B, s: 'm', id: 'y', mine: true, ts: 105 }],
		[{ c: B, s: 'c', ts: 108 }],
		[{ c: CA, s: 'k', ts: 50 }]
	];
	const tombSteps = steps.map((incoming) => {
		const added = sync.addTombs(tombs, structuredClone(incoming) as any);
		return { incoming, returns_added: added, tombs_after: structuredClone(tombs) };
	});
	const filter = sync.tombFilter(tombs);
	const tombChecks = [
		[B, { id: 'x', mine: false, ts: 200 }], [B, { id: 'y', mine: true, ts: 200 }], [B, { id: 'z', mine: false, ts: 108 }], [B, { id: 'z', mine: false, ts: 109 }],
		[CA, { id: 'q', mine: false, ts: 50 }], [CA, { id: 'q', mine: false, ts: 51 }]
	].map(([chat, msg]: any) => ({ chat, message: msg, deleted: filter(chat, msg) }));
	const cleanMessages = [
		m('ok', false, 5), { ...m('ok', true, 5), state: 'pending' }, { ...m('ok', true, 5), state: 'failed' }, { ...m('ok', false, 5), state: 'failed' },
		{ ...m('bad id', false, 5) }, { ...m('ok', false, 5), ts: 'x' }, { ...m('ok', false, 5), text: 5 }, { ...m('ok', 'yes' as any, 5) },
		m('ok', false, 5, { text: 'a'.repeat(5000) }), m('ok', true, 5, { delivery: 'delivered', edited: 7, reply: { id: 'r', from: B, text: 'q' } }),
		m('ok', true, 5, { delivery: 'weird' }), m('ok', false, 5, { att: { nope: 1 } })
	].map((value) => ({ input: value, output: devices.cleanMessage(value, C.MAX_TEXT) }));
	const cleanTombs = [[{ c: B, s: 'c', ts: 5.9 }], [{ c: 'zz', s: 'c', ts: 5 }], [{ c: B, s: 'm', id: 'a', mine: true, ts: 5 }], [{ c: B, s: 'm', id: 'a', ts: 5 }], [{ c: B, s: 'c', ts: NOW + 25 * 3600_000 }], [{ c: B, s: 'c', ts: -1 }], [{ c: B, s: 'q', ts: 5 }], 'x']
		.map((value) => ({ input: value, now: NOW, output: sync.cleanTombs(value, NOW) }));
	const cursors = [{ c: B, t: 5, i: 'a' }, { c: B, t: '5', i: 'a' }, { c: B, t: 5, i: 'bad id' }, { c: 'zz', t: 5, i: 'a' }, null]
		.map((value) => ({ input: value, output: sync.cleanCursor(value) }));
	return {
		note: 'Pure helpers from sync.ts/devices.ts. history_pages uses maxBytes = 250 so a tiny chat splits into several pages; each page starts strictly after the previous cursor. Page size rule: bytes = UTF-8 length of JSON.stringify(message) + 20; a page always holds at least one message.',
		merge_messages: merge,
		history_pages: { chats, max_bytes: 250, pages },
		add_tombs: tombSteps,
		tomb_filter_checks: tombChecks,
		clean_message: cleanMessages,
		clean_tombs: cleanTombs,
		clean_cursor: cursors
	};
}

// ── attachments ──────────────────────────────────────────────────────────────────────────

const pattern = (n: number) => Uint8Array.from({ length: n }, (_, j) => (j * 131 + 17) % 251);

function fileVectors(): J {
	const sizes = [0, 1, 100, 65535, 65536, 65537, 131072, 131073];
	const cases = sizes.map((size) => {
		const key = hex(sha256(utf8ToBytes('miga-vectors-file-key/' + size)));
		const base = nonceOf('file-base/' + size);
		force(key);
		force(base);
		const plain = pattern(size);
		const e = attach.encryptFile(plain);
		if (e.key !== key || e.nonce !== base) throw new Error('forced file key/nonce not used');
		const count = Math.max(1, Math.ceil(size / attach.CHUNK));
		const full = attach.CHUNK + 16;
		const chunks = Array.from({ length: count }, (_, i) => {
			const last = i === count - 1;
			const nonce = refChunkNonce(fromHex(base), BigInt(i));
			const part = e.cipher.subarray(i * full, (i + 1) * full);
			// Independent re-computation must match what the real module produced.
			const again = xchacha20poly1305(fromHex(key), nonce, Uint8Array.of(last ? 1 : 0)).encrypt(plain.subarray(i * attach.CHUNK, (i + 1) * attach.CHUNK));
			if (hex(again) !== hex(part)) throw new Error(`chunk ${i} of ${size}: reference disagrees`);
			return { index: i, nonce: hex(nonce), aad: last ? '01' : '00', plain_len: Math.min(attach.CHUNK, size - i * attach.CHUNK), cipher_len: part.length, cipher_sha256: hex(sha256(part)) };
		});
		const decrypted = attach.decryptFile(e.cipher, { key, nonce: base, hash: e.hash, size });
		if (hex(sha256(decrypted)) !== e.hash) throw new Error('roundtrip failed');
		const negatives: J[] = [];
		const attempt = (name: string, fn: () => Uint8Array, expect_note = '') => {
			let result = 'ok';
			let reason = '';
			try { fn(); } catch (err) { result = 'error'; reason = (err as Error).message; }
			negatives.push({ name, result, ...(reason ? { reason } : {}), ...(expect_note ? { note: expect_note } : {}) });
		};
		const meta = { key, nonce: base, hash: e.hash, size };
		if (count > 1) {
			attempt('drop_last_chunk', () => attach.decryptFile(e.cipher.subarray(0, (count - 1) * full), meta), 'the final-chunk AAD makes truncation fail (or the size check does)');
		}
		const flipped = e.cipher.slice();
		flipped[flipped.length - 1] ^= 1;
		attempt('flip_last_byte', () => attach.decryptFile(flipped, meta));
		attempt('wrong_hash', () => attach.decryptFile(e.cipher, { ...meta, hash: '00'.repeat(32) }));
		attempt('wrong_size_plus_1', () => attach.decryptFile(e.cipher, { ...meta, size: size + 1 }));
		return {
			size, pattern: 'plain[j] = (j * 131 + 17) % 251', key, base_nonce: base, hash: e.hash,
			cipher_len: e.cipher.length, chunk_count: count, cipher_sha256: hex(sha256(e.cipher)), chunks,
			...(e.cipher.length <= 200 ? { cipher: hex(e.cipher) } : {}),
			negative: negatives
		};
	});
	// Cross-check the reference chunk-nonce function against the real code for 300 chunks (19.6 MB).
	{
		const size = attach.CHUNK * 299 + 5;
		const key = hex(sha256(utf8ToBytes('big-key')));
		const base = nonceOf('big-base');
		force(key);
		force(base);
		const plain = pattern(size);
		const e = attach.encryptFile(plain);
		const full = attach.CHUNK + 16;
		for (let i = 0; i < 300; i++) {
			const last = i === 299;
			const part = e.cipher.subarray(i * full, (i + 1) * full);
			const again = xchacha20poly1305(fromHex(key), refChunkNonce(fromHex(base), BigInt(i)), Uint8Array.of(last ? 1 : 0)).encrypt(plain.subarray(i * attach.CHUNK, (i + 1) * attach.CHUNK));
			if (hex(again) !== hex(part)) throw new Error('reference chunk nonce disagrees at chunk ' + i);
		}
	}
	const base = nonceOf('nonce-table');
	const counters = [0n, 1n, 255n, 256n, 65535n, 65536n, 2n ** 32n - 1n, 2n ** 32n, 2n ** 32n + 1n, 2n ** 40n + 5n];
	return {
		note: 'File = chunks of 65536 plaintext bytes, last chunk 0..65536 (empty file = one empty chunk). Chunk i: XChaCha20-Poly1305(key, nonce_i, aad = 0x01 if last else 0x00). Ciphertext = concatenated sealed chunks. Receiver checks cipher_len == size + count*16, then SHA-256(plain) == hash. cases[].chunks come from the real encryptFile and were cross-checked with an independent implementation.',
		chunk_nonce_table: {
			note: 'nonce_i = base XOR (u64 big-endian i in the LAST 8 bytes). Verified against the real module up to i = 299; entries >= 2^32 come from the reference implementation (the real helper is private and would need a 256 TiB file).',
			base_nonce: base,
			entries: counters.map((i) => ({ counter: i.toString(), nonce: hex(refChunkNonce(fromHex(base), i)) }))
		},
		cases
	};
}

// ── main ─────────────────────────────────────────────────────────────────────────────────

export async function build(): Promise<Record<string, unknown>> {
	installDeterminism();
	resetRng();
	return {
		'identity.json': identityVectors(),
		'auth.json': authVectors(),
		'pair-key.json': pairKeyVectors(),
		'safety.json': safetyVectors(),
		'envelope.json': sealCases(),
		'envelope-raw.json': rawCases(),
		'envelope-negative.json': negativeCases(),
		'padding.json': paddingVectors(),
		'validators.json': validatorVectors(),
		'address.json': addressVectors(),
		'link.json': await linkVectors(),
		'sync-seal.json': syncSealVectors(),
		'sync-logic.json': syncLogicVectors(),
		'file-chunks.json': fileVectors()
	};
}

if (import.meta.main) {
	const dir = new URL('./test-vectors/', import.meta.url);
	await Deno.mkdir(dir, { recursive: true });
	const files = await build();
	for (const [name, value] of Object.entries(files)) {
		await Deno.writeTextFile(new URL(name, dir), JSON.stringify(value, null, 2) + '\n');
	}
	console.log(`wrote ${Object.keys(files).length} files to protocol/test-vectors/`);
}

void ed25519;
void edwardsToMontgomeryPriv;
