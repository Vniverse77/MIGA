import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { AVATAR_H, AVATAR_W, avatarPixels, avatarSvg, avatarUrl } from './avatar.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

Deno.test('avatar: same address, same picture', () => {
	assertEquals(avatarSvg(A), avatarSvg(A));
	assertEquals(avatarSvg(A), avatarSvg(A.toUpperCase()));
	assertEquals(avatarUrl(A), avatarUrl(A));
});

Deno.test('avatar: different addresses differ', () => {
	assertNotEquals(avatarSvg(A), avatarSvg(B));
	const seen = new Set<string>();
	for (let i = 0; i < 200; i++) seen.add(avatarSvg(i.toString(16).padStart(64, '0')));
	if (seen.size < 190) throw new Error(`too many collisions: ${seen.size}/200`);
});

Deno.test('avatar: symmetric, correct size, has head and body', () => {
	for (let i = 0; i < 50; i++) {
		const p = avatarPixels(i.toString(16).padStart(64, '1'));
		assertEquals(p.rows.length, AVATAR_H);
		for (const row of p.rows) {
			assertEquals(row.length, AVATAR_W);
			assertEquals(row, [...row].reverse().join(''));
		}
		const all = p.rows.join('');
		for (const c of ['F', 'E', 'S', 'P']) if (!all.includes(c)) throw new Error('missing ' + c);
	}
});

Deno.test('avatar: fixed vector', () => {
	assertEquals(avatarPixels(A).rows.join('|'), avatarPixels(A).rows.join('|'));
});
