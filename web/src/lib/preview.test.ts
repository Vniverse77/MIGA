import { assert, assertEquals } from 'jsr:@std/assert@1';
import { cleanPreview, firstLink, parseMeta, PREVIEW_CAPS } from './preview.ts';

const att = { blob: 'a'.repeat(32), key: 'b'.repeat(64), nonce: 'c'.repeat(48), hash: 'd'.repeat(64), mime: 'image/webp', size: 12000, w: 512, h: 268, thumb: '' };

Deno.test('Open Graph tags win over plain ones', () => {
	const html = `<!doctype html><html><head><title>Plain &amp; title</title>
		<meta name="description" content="plain description">
		<meta property="og:title" content="OG &quot;Title&quot; &#38; more">
		<meta property="og:description" content='OG desc'>
		<meta property="og:site_name" content="Example">
		<meta property="og:image" content="/img/card.png"></head><body><meta property="og:title" content="late"></body></html>`;
	const m = parseMeta(html, 'https://www.example.com/post/1');
	assertEquals(m.title, 'OG "Title" & more');
	assertEquals(m.desc, 'OG desc');
	assertEquals(m.site, 'Example');
	assertEquals(m.image, 'https://www.example.com/img/card.png');
});

Deno.test('falls back to twitter, title, description and host', () => {
	const m = parseMeta(`<title> Hello\n  world </title><meta name="twitter:image" content="https://cdn.example.org/a.jpg"><meta name="description" content="d">`, 'https://www.example.org/x');
	assertEquals([m.title, m.desc, m.site, m.image], ['Hello world', 'd', 'example.org', 'https://cdn.example.org/a.jpg']);
});

Deno.test('ignores scripts, comments and non-http images', () => {
	const m = parseMeta(`<!-- <meta property="og:title" content="no"> --><script>var a='<meta property="og:title" content="no2">'</script><title>Real</title><meta property="og:image" content="javascript:alert(1)"><meta property="og:image" content="data:image/png;base64,AAAA">`, 'https://a.test/');
	assertEquals(m.title, 'Real');
	assertEquals(m.image, '');
});

Deno.test('fields are capped and control characters removed', () => {
	const m = parseMeta(`<title>${'x'.repeat(900)}</title><meta property="og:description" content="${'y'.repeat(900)}‮ rtl"><meta property="og:site_name" content="${'z'.repeat(900)}">`, 'https://a.test/');
	assertEquals(m.title.length, PREVIEW_CAPS.title);
	assertEquals(m.desc.length, PREVIEW_CAPS.desc);
	assertEquals(m.site.length, PREVIEW_CAPS.site);
	assert(!m.desc.includes('‮'));
});

Deno.test('first link of a text', () => {
	assertEquals(firstLink('look https://vniverse77.com/x, nice'), 'https://vniverse77.com/x');
	assertEquals(firstLink('no link here'), null);
	assertEquals(firstLink('ftp://x.test'), null);
});

Deno.test('cleanPreview: valid, link must be in the text, caps, bad image dropped', () => {
	const text = 'see https://vniverse77.com/';
	const ok = cleanPreview({ url: 'https://vniverse77.com/', title: 'T', desc: '', site: 'S', img: att }, text);
	assertEquals(ok?.title, 'T');
	assertEquals(ok?.img?.blob, att.blob);
	assertEquals(cleanPreview({ url: 'https://evil.test/', title: 'T' }, text), null);
	assertEquals(cleanPreview({ url: 'javascript:alert(1)', title: 'T' }, 'javascript:alert(1)'), null);
	assertEquals(cleanPreview({ url: 'https://vniverse77.com/' }, text), null);
	assertEquals(cleanPreview('x', text), null);
	const big = cleanPreview({ url: 'https://vniverse77.com/', title: 't'.repeat(5000), desc: 'd'.repeat(5000), site: 's'.repeat(5000) }, text)!;
	assertEquals([big.title.length, big.desc.length, big.site.length], [200, 300, 80]);
	assertEquals(cleanPreview({ url: 'https://vniverse77.com/', title: 'T', img: { ...att, w: 4000 } }, text)?.img, undefined);
	assertEquals(cleanPreview({ url: 'https://vniverse77.com/', title: 'T', img: { ...att, mime: 'video/mp4' } }, text)?.img, undefined);
	assertEquals(cleanPreview({ url: 'https://vniverse77.com/', title: 'T', img: { ...att, size: 400_000 } }, text)?.img, undefined);
});

Deno.test('cleanPreview keeps the delete token only for own messages', () => {
	const text = 'https://vniverse77.com/';
	const withDel = { ...att, del: 'e'.repeat(32) };
	assertEquals(cleanPreview({ url: text, title: 'T', img: withDel }, text)?.img?.del, undefined);
	assertEquals(cleanPreview({ url: text, title: 'T', img: withDel }, text, true)?.img?.del, 'e'.repeat(32));
});

import { decrypt, encrypt, newIdentity } from './crypto.ts';

Deno.test('preview travels inside the encrypted message, drops the delete token, and old readers still get the text', () => {
	const a = newIdentity();
	const b = newIdentity();
	const text = 'read https://vniverse77.com/ now';
	const prev = { url: 'https://vniverse77.com/', title: 'Vniverse77', desc: 'd', site: 'vniverse77.com', img: { ...att, del: 'e'.repeat(32) } };
	const body = encrypt(a, b.address, text, undefined, undefined, undefined, undefined, prev);
	const plain = decrypt(b, a.address, body)!;
	assertEquals(plain.text, text);
	assertEquals(plain.prev?.title, 'Vniverse77');
	assertEquals(plain.prev?.img?.del, undefined);
	// A preview about another link than the one in the text is dropped, the message stays.
	const forged = decrypt(b, a.address, encrypt(a, b.address, 'hello https://other.test/', undefined, undefined, undefined, undefined, prev))!;
	assertEquals(forged.text, 'hello https://other.test/');
	assertEquals(forged.prev, undefined);
	// No preview: nothing extra on the wire.
	assertEquals(decrypt(b, a.address, encrypt(a, b.address, text))!.prev, undefined);
});
