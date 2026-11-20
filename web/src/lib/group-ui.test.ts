import { assertEquals } from 'jsr:@std/assert@1';
import { canCreate, canInvite, canRename, filterCandidates, insertMention, memberActions, memberColor, mentionParts, mentionQuery, mentionToken, mustTransferBeforeLeaving, parseMentions, pickableContacts, rowPreview } from './group-ui.ts';
import { groupAvatarSvg } from './avatar.ts';
import { sysId, systemLines, type GroupRecord } from './groups.ts';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64), E = 'e'.repeat(64);
const names: Record<string, string> = { [A]: 'Test Alpha', [B]: 'Test Beta', [C]: 'Test Gamma', [D]: 'Delta' };
const nameOf = (a: string) => names[a] ?? a.slice(0, 6);
const cands = [A, B, C, D].map((address) => ({ address, name: nameOf(address) }));
const rec = (over: Partial<GroupRecord['state']> = {}, r: Partial<GroupRecord> = {}): GroupRecord => ({
	state: { id: 'f'.repeat(32), name: 'G', admin: A, members: [A, B, C], banned: [], epoch: 1, createdAt: 0, ...over },
	sig: '', signer: A, status: 'active', accepted: [A], left: [], since: 0, ...r
});

Deno.test('mentions: query at the caret', () => {
	assertEquals(mentionQuery('hi @Te', 6), { start: 3, query: 'Te' });
	assertEquals(mentionQuery('@', 1), { start: 0, query: '' });
	assertEquals(mentionQuery('mail me@x', 9), null);
	assertEquals(mentionQuery('hi @Te there', 12), null);
	assertEquals(mentionQuery('no at', 5), null);
});

Deno.test('mentions: filter, insert, parse', () => {
	assertEquals(filterCandidates(cands, 'be').map((c) => c.address), [B]);
	assertEquals(filterCandidates(cands, 'test').length, 3);
	assertEquals(filterCandidates(cands, 'ta').map((c) => c.address), [B, D]); // contains
	assertEquals(mentionToken('Test Beta'), '@Test_Beta');
	const r = insertMention('hi @Te', 3, 6, 'Test Beta');
	assertEquals(r, { text: 'hi @Test_Beta ', caret: 14 });
	assertEquals(parseMentions('hi @Test_Beta and @delta, @nobody @Test_Beta', cands), [B, D]); // trailing comma is not part of the name
	assertEquals(parseMentions('@Test_Gamma @Delta', cands), [C, D]);
});

Deno.test('mentions: rendering into chips', () => {
	const p = mentionParts('hi @Test_Beta!', [B], nameOf);
	assertEquals(p, [{ t: 'hi ' }, { t: '@Test Beta', mention: B }, { t: '!' }]);
	// the sender knew them under another name: assigned by position
	assertEquals(mentionParts('yo @Bobby ok', [B], nameOf), [{ t: 'yo ' }, { t: '@Test Beta', mention: B }, { t: ' ok' }]);
	assertEquals(mentionParts('plain @text', undefined, nameOf), [{ t: 'plain @text' }]);
	assertEquals(mentionParts('x @Delta @Test_Beta', [B, D], nameOf).filter((x) => x.mention).map((x) => x.mention), [D, B]);
});

Deno.test('member colours: stable and distinct inside a group', () => {
	const members = [A, B, C, D, E];
	const slots = members.map((m) => memberColor(members, m));
	assertEquals(new Set(slots).size, 5);
	assertEquals(memberColor([E, D, C, B, A], B), memberColor(members, B));
});

Deno.test('permissions', () => {
	const r = rec();
	assertEquals(memberActions(r, A, B), ['admin', 'remove', 'ban']);
	assertEquals(memberActions(r, A, A), []);
	assertEquals(memberActions(r, B, C), []);
	assertEquals(memberActions(r, A, D), []);
	assertEquals(canRename(r, A), true);
	assertEquals(canRename(r, B), false);
	assertEquals(canInvite(r, A), true);
	assertEquals(canInvite(rec({ members: [A, B, C, D, E] }), A), false);
	assertEquals(mustTransferBeforeLeaving(r, A), true);
	assertEquals(mustTransferBeforeLeaving(rec({ members: [A] }), A), false);
	assertEquals(mustTransferBeforeLeaving(r, B), false);
	assertEquals(memberActions(rec({}, { status: 'left' }), A, B), []);
});

Deno.test('creating: contacts only, 1 to 4 picked', () => {
	const list = [{ address: A }, { address: B, request: true }, { address: C }];
	assertEquals(pickableContacts(list, [C]).map((c) => c.address), [A]);
	assertEquals(canCreate('', 2), false);
	assertEquals(canCreate('Crew', 0), false);
	assertEquals(canCreate('Crew', 4), true);
	assertEquals(canCreate('Crew', 5), false);
});

Deno.test('system lines from state changes', () => {
	const before = rec({ epoch: 1, members: [A, B] }, { accepted: [A] });
	const added = rec({ epoch: 2, members: [A, B, C] }, { accepted: [A] });
	assertEquals(systemLines(before, added).map((x) => x.line), [{ k: 'added', by: A, who: C }]);
	assertEquals(systemLines(undefined, before).map((x) => x.line.k), ['created']);
	const left = rec({ epoch: 3, members: [A, B] }, { accepted: [A] });
	assertEquals(systemLines({ ...added, left: [C] }, left).map((x) => x.line), [{ k: 'left', who: C }]);
	assertEquals(systemLines(added, left).map((x) => x.line), [{ k: 'removed', by: A, who: C }]);
	const banned = rec({ epoch: 3, members: [A, B], banned: [C] });
	assertEquals(systemLines(added, banned).map((x) => x.line.k), ['banned']);
	assertEquals(systemLines(banned, rec({ epoch: 4, members: [A, B], banned: [] })).map((x) => x.line.k), ['unbanned']);
	assertEquals(systemLines(before, rec({ epoch: 2, members: [A, B], name: 'New' })).map((x) => x.line), [{ k: 'renamed', by: A, name: 'New' }]);
	assertEquals(systemLines(added, { ...added, accepted: [A, B] }).map((x) => x.line), [{ k: 'joined', who: B }]);
	assertEquals(sysId('f'.repeat(32), 2, { k: 'added', who: C }), sysId('f'.repeat(32), 2, { k: 'added', who: C }));
	assertEquals(/^[0-9a-f]{32}$/.test(sysId('f'.repeat(32), 2, { k: 'added', who: C })), true);
});

Deno.test('row preview and group avatar', () => {
	const sys = () => 'sys';
	const m = { gid: 'g', id: 'i', from: B, mine: false, text: 'hello', ts: 1 };
	assertEquals(rowPreview(m, nameOf, sys, 'Photo', 'You'), 'Test Beta: hello');
	assertEquals(rowPreview({ ...m, text: '', att: undefined }, nameOf, sys, 'Photo', 'You'), 'Test Beta: Photo');
	assertEquals(rowPreview({ ...m, mine: true }, nameOf, sys, 'Photo', 'You'), 'You: hello');
	assertEquals(rowPreview({ ...m, sys: { k: 'created' } }, nameOf, sys, 'Photo', 'You'), 'sys');
	assertEquals(groupAvatarSvg('a'.repeat(32)), groupAvatarSvg('a'.repeat(32)));
	const seen = new Set<string>();
	for (let i = 0; i < 100; i++) seen.add(groupAvatarSvg(i.toString(16).padStart(32, '0')));
	if (seen.size < 95) throw new Error('too many group avatar collisions ' + seen.size);
});
