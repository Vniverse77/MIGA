import { assert, assertEquals } from 'jsr:@std/assert@1';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
import { cleanPhoto, decrypt, encrypt, encryptPhoto, type Identity } from './crypto.ts';
import { cropRect } from './photo.ts';

const mk = (): Identity => {
	const secret = randomBytes(32);
	return { secret, address: bytesToHex(ed25519.getPublicKey(secret)) };
};
const att = {
	blob: 'a'.repeat(32), key: 'b'.repeat(64), nonce: 'c'.repeat(48), hash: 'd'.repeat(64),
	mime: 'image/webp', size: 9000, w: 256, h: 256, thumb: ''
};

Deno.test('photo: control message round trip, no del token or thumb on the wire', () => {
	const a = mk(), b = mk();
	const body = encryptPhoto(a, b.address, { ...att, del: 'e'.repeat(32), thumb: 'data:image/webp;base64,AAAA' });
	const plain = decrypt(b, a.address, body)!;
	assert(plain && plain.text === '' && plain.photo && 'att' in plain.photo);
	assertEquals((plain.photo as { att: typeof att & { del?: string } }).att.del, undefined);
	assertEquals((plain.photo as { att: typeof att }).att.thumb, '');
});

Deno.test('photo: removal message', () => {
	const a = mk(), b = mk();
	assertEquals(decrypt(b, a.address, encryptPhoto(a, b.address, null))!.photo, { off: true });
});

Deno.test('photo: rejects non-image and oversized attachments', () => {
	assertEquals(cleanPhoto({ att: { ...att, mime: 'video/mp4' } }), null);
	assertEquals(cleanPhoto({ att: { ...att, size: 5_000_000 } }), null);
	assertEquals(cleanPhoto({ att: { ...att, blob: 'zz' } }), null);
	assertEquals(cleanPhoto({}), null);
	assertEquals(cleanPhoto(null), null);
});

Deno.test('photo: ordinary messages still decrypt', () => {
	const a = mk(), b = mk();
	assertEquals(decrypt(b, a.address, encrypt(a, b.address, 'hi'))!.text, 'hi');
});

Deno.test('photo: crop rectangle stays inside the image', () => {
	const r = cropRect(400, 200, { zoom: 1, x: 0, y: 0 });
	assertEquals(r, { sx: 100, sy: 0, side: 200 });
	for (const x of [-5, -1, 0, 1, 5]) {
		const c = cropRect(400, 200, { zoom: 2, x, y: x });
		assert(c.sx >= 0 && c.sy >= 0 && c.sx + c.side <= 400 && c.sy + c.side <= 200);
	}
	assertEquals(cropRect(100, 100, { zoom: NaN, x: NaN, y: 0 }).side, 100);
});
