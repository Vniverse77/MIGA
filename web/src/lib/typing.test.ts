import { assertEquals } from 'jsr:@std/assert@1';
import { cleanPinState, MAX_PINNED_CHATS, orderWithPins, toggleChatPin, cleanPins, isPinned, MAX_PINS, pinKey, prunePins, togglePin, unpin, type Pins } from './pins.ts';
import { resolveTypingMode, TYPING_IDLE, TYPING_REFRESH_MS, typingStep } from './typing.ts';

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);

Deno.test('pins: newest first, at most three, unpin and prune', () => {
	const pins: Pins = {};
	assertEquals(togglePin(pins, A, 'm1'), true);
	togglePin(pins, A, 't2');
	togglePin(pins, A, 'm3');
	togglePin(pins, A, 't4');
	assertEquals(pins[A], ['t4', 'm3', 't2']);
	assertEquals(pins[A].length, MAX_PINS);
	assertEquals(togglePin(pins, A, 'm3'), false);
	assertEquals(isPinned(pins, A, 'm3'), false);
	assertEquals(prunePins(pins, A, new Set(['t4'])), true);
	assertEquals(pins[A], ['t4']);
	assertEquals(unpin(pins, A, 't4'), true);
	assertEquals(pins[A], undefined);
	assertEquals(pinKey({ id: 'x', mine: true }), 'mx');
});

Deno.test('pins: synced or stored junk is cleaned', () => {
	const clean = cleanPins({ [A]: ['m1', 'm1', 'bad key', 5, 't2', 't3', 't4'], nope: ['m1'], [B]: [] });
	assertEquals(clean, { [A]: ['m1', 't2', 't3'] });
	assertEquals(cleanPins('x'), {});
});

Deno.test('typing mode: migration keeps live text, everyone else gets the indicator', () => {
	assertEquals(resolveTypingMode(null, '1'), 'live');
	assertEquals(resolveTypingMode(null, '0'), 'typing');
	assertEquals(resolveTypingMode(null, null), 'typing');
	assertEquals(resolveTypingMode('off', '1'), 'off');
	assertEquals(resolveTypingMode('weird', '1'), 'live');
});

Deno.test('typing: start, throttled refresh every 3 s, stop frame', () => {
	let s = TYPING_IDLE;
	let r = typingStep(s, A, true, 1000);
	assertEquals(r.frames, [{ to: A, typing: true }]);
	s = r.state;
	r = typingStep(s, A, true, 1500);
	assertEquals(r.frames, []);
	s = r.state;
	r = typingStep(s, A, true, 1000 + TYPING_REFRESH_MS - 1);
	assertEquals(r.frames, []);
	r = typingStep(s, A, true, 1000 + TYPING_REFRESH_MS);
	assertEquals(r.frames, [{ to: A, typing: true }]);
	s = r.state;
	r = typingStep(s, A, false, 9000); // box emptied / message sent
	assertEquals(r.frames, [{ to: A, typing: false }]);
	assertEquals(typingStep(r.state, A, false, 9100).frames, []);
});

Deno.test('typing: chat switch and "nothing may be sent" stop the old chat; idle sends nothing', () => {
	let r = typingStep(TYPING_IDLE, A, true, 0);
	r = typingStep(r.state, B, true, 100);
	assertEquals(r.frames, [{ to: A, typing: false }, { to: B, typing: true }]);
	r = typingStep(r.state, null, true, 200); // blur, setting off, blocked
	assertEquals(r.frames, [{ to: B, typing: false }]);
	assertEquals(typingStep(r.state, null, true, 300).frames, []);
	assertEquals(typingStep(TYPING_IDLE, A, false, 0).frames, []);
});

Deno.test('pinned chats: up to five, pin order on top, junk cleaned', () => {
	const addrs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((c, i) => c.repeat(2) + String(i).repeat(62));
	const list: string[] = [];
	for (const a of addrs.slice(0, 6)) toggleChatPin(list, a);
	assertEquals(list.length, MAX_PINNED_CHATS);
	assertEquals(list[0], addrs[5]);
	assertEquals(toggleChatPin(list, addrs[5]), false);
	const ordered = orderWithPins(addrs.map((address) => ({ address })), [addrs[3], addrs[1]]).map((c) => c.address);
	assertEquals(ordered.slice(0, 3), [addrs[3], addrs[1], addrs[0]]);
	assertEquals(cleanPinState({ c: [A, A, 'x'], m: 5 }), { m: {}, c: [A] });
});
