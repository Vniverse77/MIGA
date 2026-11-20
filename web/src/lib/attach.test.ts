import { assertEquals } from 'jsr:@std/assert@1';
import { sniffMime } from './attach.ts';

const bytes = (...parts: (number[] | string)[]) =>
	Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const ftyp = (brand: string) => bytes([0, 0, 0, 24], 'ftyp', brand, [0, 0, 0, 0], 'mif1heic');

Deno.test('sniffMime: common photo formats', () => {
	assertEquals(sniffMime(bytes([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
	assertEquals(sniffMime(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
	assertEquals(sniffMime(bytes('GIF89a')), 'image/gif');
	assertEquals(sniffMime(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), 'image/webp');
});

Deno.test('sniffMime: every HEIF/AVIF brand is a still picture, other ftyp brands are video', () => {
	for (const b of ['heic', 'heix', 'heim', 'heis', 'hevc', 'mif1', 'msf1', 'heif', 'avif']) assertEquals(sniffMime(ftyp(b)), 'image/heic', b);
	for (const b of ['isom', 'mp42', 'qt  ', 'M4V ']) assertEquals(sniffMime(ftyp(b)), 'video/mp4', b);
});

Deno.test('sniffMime: unknown or empty data has no type', () => {
	assertEquals(sniffMime(new Uint8Array(0)), '');
	assertEquals(sniffMime(bytes('hello world, not a picture')), '');
});
