import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { cleanEdit, cleanIds, cleanPhoto, decrypt, encryptGroup, newIdentity, randomId } from './crypto.ts';
import { canonicalState, cleanState, GroupError, judgeState, MAX_MEMBERS, signState, verifyState, wireId, type GroupState } from './groups.ts';
import { Net } from './group-testkit.test.ts';
import { powDay, solveSync } from './pow.ts';

/** The error code a promise rejects with, or 'none'. */
async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return 'none';
	} catch (e) {
		return (e as GroupError).code ?? String(e);
	}
}

/** A group of `n` clients (admin first), everybody accepted. */
async function makeGroup(n: number) {
	const net = new Net();
	const names = ['Test Alpha', 'Test Bravo', 'Test Charlie', 'Test Delta', 'Test Echo'];
	const cs = names.slice(0, n).map((x) => net.client(x));
	const [admin, ...rest] = cs;
	for (const c of rest) c.know(admin);
	const rec = await admin.engine.create('Test Group', rest.map((c) => c.address));
	await net.pump();
	const gid = rec.state.id;
	for (const c of rest) await c.engine.accept(gid);
	await net.pump();
	return { net, cs, admin, rest, gid };
}

function state(admin: string, members: string[], epoch = 1, extra: Partial<GroupState> = {}): GroupState {
	return { id: 'a'.repeat(32), name: 'Test Group', admin, members, banned: [], epoch, createdAt: 1, ...extra };
}

// ── State, signature, epoch ─────────────────────────────────────────────────────────────

Deno.test('signature: valid state verifies; a change, another key or a malformed signature does not', () => {
	const a = newIdentity(), b = newIdentity();
	const st = state(a.address, [a.address, b.address]);
	const sig = signState(a, st);
	assert(verifyState(st, sig, a.address));
	assertFalse(verifyState({ ...st, name: 'Other' }, sig, a.address));
	assertFalse(verifyState({ ...st, epoch: 2 }, sig, a.address));
	assertFalse(verifyState(st, sig, b.address));
	assertFalse(verifyState(st, 'zz', a.address));
	assertFalse(verifyState(st, '0'.repeat(128), a.address));
	// the signed bytes do not depend on the order of the lists
	assertEquals(sig, signState(a, { ...st, members: [...st.members].reverse() }));
	assertEquals(canonicalState(st).startsWith('{"id":'), true);
});

Deno.test('signState refuses to sign for somebody else', () => {
	const a = newIdentity(), b = newIdentity();
	let code = '';
	try {
		signState(b, state(a.address, [a.address]));
	} catch (e) {
		code = (e as GroupError).code;
	}
	assertEquals(code, 'not_admin');
});

Deno.test('cleanState: invariants (max 5, distinct, admin is a member, banned apart, epoch >= 1)', () => {
	const ids = Array.from({ length: 6 }, () => newIdentity().address);
	const ok = state(ids[0], ids.slice(0, 5));
	assert(cleanState(ok));
	assertEquals(MAX_MEMBERS, 5);
	assertEquals(cleanState({ ...ok, members: ids }), null, '6 members');
	assertEquals(cleanState({ ...ok, members: [ids[0], ids[0]] }), null, 'duplicate');
	assertEquals(cleanState({ ...ok, members: ids.slice(1, 3) }), null, 'admin missing');
	assertEquals(cleanState({ ...ok, banned: [ids[1]] }), null, 'banned and member');
	assertEquals(cleanState({ ...ok, epoch: 0 }), null);
	assertEquals(cleanState({ ...ok, name: '   ' }), null);
	assertEquals(cleanState({ ...ok, members: [ids[0], 'nothex'] }), null);
	assertEquals(cleanState(null), null);
});

Deno.test('judgeState: epoch must grow, the known admin must have signed, the sender must be that admin', () => {
	const a = newIdentity(), m = newIdentity(), evil = newIdentity();
	const s2 = state(a.address, [a.address, m.address], 2);
	const known = { state: s2 };
	const s3 = state(a.address, [a.address, m.address], 3, { name: 'New' });
	assertEquals(judgeState(known, { st: s3, sig: signState(a, s3) }, a.address).ok, true);
	assertEquals(judgeState(known, { st: s2, sig: signState(a, s2) }, a.address), { ok: false, reason: 'stale' });
	const old = state(a.address, [a.address], 1);
	assertEquals(judgeState(known, { st: old, sig: signState(a, old) }, a.address), { ok: false, reason: 'stale' });
	// a member (or an outsider) who claims to be the admin of a known group
	const claimed = state(evil.address, [evil.address, m.address], 9);
	assertEquals(judgeState(known, { st: claimed, sig: signState(evil, claimed) }, evil.address), { ok: false, reason: 'bad_signature' });
	// right signature, but delivered by somebody else (a replay by a member is not an admin message)
	assertEquals(judgeState(known, { st: s3, sig: signState(a, s3) }, m.address), { ok: false, reason: 'wrong_sender' });
	assertEquals(judgeState(known, { st: s3, sig: signState(a, s3) }, m.address, true).ok, true, 'own device (sync) may carry it');
	// unknown group: the state names its admin, who must be the sender
	assertEquals(judgeState(undefined, { st: s3, sig: signState(a, s3) }, a.address).ok, true);
	assertEquals(judgeState(undefined, { st: s3, sig: signState(a, s3) }, m.address), { ok: false, reason: 'wrong_sender' });
	assertEquals(judgeState(undefined, { st: s3, sig: '0'.repeat(128) }, a.address), { ok: false, reason: 'bad_signature' });
	assertEquals(judgeState(undefined, { st: { ...s3, members: [] }, sig: '' }, a.address), { ok: false, reason: 'malformed' });
});

// ── Create, invite, accept ──────────────────────────────────────────────────────────────

Deno.test('create + accept: invitees are invited until they accept; everyone learns who accepted', async () => {
	const net = new Net();
	const [a, b, c] = ['Test Alpha', 'Test Bravo', 'Test Charlie'].map((n) => net.client(n));
	b.know(a);
	c.know(a);
	const rec = await a.engine.create('Test Group', [b.address, c.address]);
	await net.pump();
	assertEquals(rec.state.members.length, 3);
	assertEquals(b.engine.get(rec.state.id)?.status, 'invited');
	assertEquals(c.engine.get(rec.state.id)?.state.name, 'Test Group');
	assertEquals(b.engine.invites().length, 1);
	assertEquals(b.engine.get(rec.state.id)?.request, undefined, 'the admin is a contact: not a request');
	await b.engine.accept(rec.state.id);
	await net.pump();
	assertEquals(b.engine.get(rec.state.id)?.status, 'active');
	assertEquals(a.engine.get(rec.state.id)?.accepted.includes(b.address), true);
	assertEquals(c.engine.get(rec.state.id)?.accepted.includes(b.address), true);
	assertEquals(a.engine.get(rec.state.id)?.accepted.includes(c.address), false);
});

Deno.test('limit of 5: create and invite both refuse the 6th member, on both sides', async () => {
	const { net, admin, gid } = await makeGroup(5);
	const extra = net.client('Test Foxtrot');
	assertEquals(await codeOf(admin.engine.invite(gid, extra.address)), 'full');
	const six = Array.from({ length: 5 }, () => newIdentity().address);
	assertEquals(await codeOf(admin.engine.create('Too big', six)), 'full');
	assertEquals(await codeOf(admin.engine.invite(gid, admin.address)), 'already_member');
	// a (forged, properly signed by a rogue admin of its own group) 6-member state is simply not a state
	const ids = Array.from({ length: 6 }, () => newIdentity());
	assertEquals(cleanState(state(ids[0].address, ids.map((i) => i.address))), null);
});

Deno.test('a state with me in it from a non-admin sender, or a bad signature, creates nothing', async () => {
	const net = new Net();
	const [a, b, evil] = ['Test Alpha', 'Test Bravo', 'Test Evil'].map((n) => net.client(n));
	const st = state(a.address, [a.address, b.address]);
	// the evil client forwards a genuine admin-signed state: right signature, wrong sender
	const sig = signState(a.id, st);
	for (const [from, s] of [[evil, sig], [a, '0'.repeat(128)]] as const) {
		const body = encryptGroup(from.id, b.address, { group: { op: 'invite', st, sig: s } });
		await b.engine.handle(from.address, decrypt(b.id, from.address, body)!, Date.now());
	}
	assertEquals(b.engine.list().length, 0);
	// the genuine thing works
	const body = encryptGroup(a.id, b.address, { group: { op: 'invite', st, sig } });
	await b.engine.handle(a.address, decrypt(b.id, a.address, body)!, Date.now());
	assertEquals(b.engine.list().length, 1);
});

// ── Messages: fan-out, dedup, mentions ──────────────────────────────────────────────────

Deno.test('fan-out: one copy per other member, each with its own relay id; all receive exactly once', async () => {
	const { net, cs, gid } = await makeGroup(5);
	const [a, b, c, d, e] = cs;
	for (const x of cs) x.sentLog.length = 0;
	const m = await b.engine.sendMessage(gid, { text: 'hello group' });
	await net.pump();
	assertEquals(b.sentLog.length, 4, 'four copies for four other members');
	assertEquals(new Set(b.sentLog.map((s) => s.to)), new Set([a, c, d, e].map((x) => x.address)));
	assertEquals(new Set(b.sentLog.map((s) => s.wid)).size, 4, 'distinct relay ids');
	for (const x of [a, c, d, e]) {
		const got = await x.messages(gid);
		assertEquals(got.length, 1);
		assertEquals(got[0].text, 'hello group');
		assertEquals(got[0].from, b.address);
		assertEquals(got[0].id, m.id);
	}
	// delivery ticks: every copy confirmed
	const mine = (await b.messages(gid))[0];
	assertEquals(Object.values(mine.to!), ['sent', 'sent', 'sent', 'sent']);
	assertEquals(b.engine.pendingCount(), 0);
});

Deno.test('dedup by message id: a re-delivered copy, a retry and a linked-device copy show once', async () => {
	const { net, cs, gid } = await makeGroup(3);
	const [a, b] = cs;
	await a.engine.sendMessage(gid, { text: 'once' });
	await net.pump();
	assertEquals((await b.messages(gid)).length, 1);
	// the same payload again under a different relay id (what a retry after a lost ack can look like)
	const g = (await b.messages(gid))[0];
	const again = encryptGroup(a.id, b.address, { g: { gid, epoch: 1, t: 'msg', id: g.id, text: 'once' } });
	await b.engine.handle(a.address, decrypt(b.id, a.address, again)!, Date.now());
	// and the sync copy from b's other device
	await b.engine.applySync({ k: 'gmsg', gid, message: g });
	assertEquals((await b.messages(gid)).length, 1);
});

Deno.test('receivers drop messages for unknown groups, from non-members, from banned and from themselves', async () => {
	const { net, cs, admin, gid } = await makeGroup(3);
	const [, b, c] = cs;
	const outsider = net.client('Test Outsider');
	const send = async (from: typeof outsider, to: typeof b, g: object) =>
		to.engine.handle(from.address, decrypt(to.id, from.address, encryptGroup(from.id, to.address, { g }))!, Date.now());
	await send(outsider, b, { gid, epoch: 1, t: 'msg', id: randomId(), text: 'sneak' });
	await send(b, c, { gid: 'e'.repeat(32), epoch: 1, t: 'msg', id: randomId(), text: 'unknown group' });
	assertEquals((await b.messages(gid)).length + (await c.messages(gid)).length, 0);
	// banned after being a member
	await admin.engine.ban(gid, c.address);
	await net.pump();
	await send(c, b, { gid, epoch: 1, t: 'msg', id: randomId(), text: 'i am banned' });
	assertEquals((await b.messages(gid)).length, 0);
});

Deno.test('mentions: a muted group stays silent, except for a message that names me', async () => {
	const { net, cs, gid } = await makeGroup(3);
	const [a, b, c] = cs;
	await b.engine.setMuted(gid, true);
	b.events.length = 0;
	c.events.length = 0;
	await a.engine.sendMessage(gid, { text: 'plain' });
	await a.engine.sendMessage(gid, { text: 'hey Bravo', mentions: [b.address, 'f'.repeat(64)] });
	await net.pump();
	const bm = b.events.filter((e) => e.type === 'message') as { message: { text: string; mentionsMe?: boolean }; notify: string }[];
	assertEquals(bm.map((e) => [e.message.text, e.notify]), [['plain', 'silent'], ['hey Bravo', 'mention']]);
	assertEquals(bm[1].message.mentionsMe, true);
	const cm = c.events.filter((e) => e.type === 'message') as { message: { mentionsMe?: boolean; mentions?: string[] }; notify: string }[];
	assertEquals(cm.map((e) => e.notify), ['normal', 'normal']);
	assertEquals(cm[1].message.mentionsMe, undefined);
	assertEquals(cm[1].message.mentions, [b.address], 'non-members are dropped from mentions');
});

Deno.test('edit and delete for everyone are author-only', async () => {
	const { net, cs, gid } = await makeGroup(3);
	const [a, b, c] = cs;
	const m = await a.engine.sendMessage(gid, { text: 'original' });
	await net.pump();
	// b tries to edit and delete a's message by hand
	const forge = async (g: object) => c.engine.handle(b.address, decrypt(c.id, b.address, encryptGroup(b.id, c.address, { g: { gid, epoch: 1, ...g } }))!, Date.now());
	await forge({ t: 'edit', eid: m.id, text: 'hacked' });
	await forge({ t: 'del', ids: [m.id] });
	assertEquals((await c.messages(gid))[0].text, 'original');
	// the author can
	assert(await a.engine.sendEdit(gid, m.id, 'edited'));
	await net.pump();
	assertEquals((await c.messages(gid))[0].text, 'edited');
	assertEquals(typeof (await c.messages(gid))[0].edited, 'number');
	assertEquals(await b.engine.sendEdit(gid, m.id, 'nope'), false, 'not my message');
	assertEquals((await b.engine.sendDelete(gid, [m.id])).length, 0);
	assertEquals((await a.engine.sendDelete(gid, [m.id])).length, 1);
	await net.pump();
	assertEquals((await b.messages(gid)).length + (await c.messages(gid)).length, 0);
});

Deno.test('replies carry the quote through the group', async () => {
	const { net, cs, gid } = await makeGroup(3);
	const [a, b] = cs;
	const m = await a.engine.sendMessage(gid, { text: 'question?' });
	await net.pump();
	await b.engine.sendMessage(gid, { text: 'answer', reply: { id: m.id, from: a.address, text: 'question?' } });
	await net.pump();
	const got = (await a.messages(gid)).find((x) => !x.mine)!;
	assertEquals(got.reply?.text, 'question?');
	assertEquals(got.reply?.from, a.address);
});

// ── Membership changes ──────────────────────────────────────────────────────────────────

Deno.test('remove: the removed member stops receiving; their messages are dropped; the others agree', async () => {
	const { net, cs, admin, gid } = await makeGroup(4);
	const [, b, c, d] = cs;
	await admin.engine.remove(gid, d.address);
	await net.pump();
	assertEquals(d.engine.get(gid)?.status, 'removed');
	assertEquals(b.engine.get(gid)?.state.members.includes(d.address), false);
	assertEquals(b.engine.get(gid)?.state.epoch, 2);
	for (const x of cs) x.sentLog.length = 0;
	await b.engine.sendMessage(gid, { text: 'after removal' });
	await admin.engine.sendMessage(gid, { text: 'admin too' });
	await net.pump();
	assertFalse(b.sentLog.some((s) => s.to === d.address) || admin.sentLog.some((s) => s.to === d.address), 'no copy for the removed');
	assertEquals((await d.messages(gid)).length, 0);
	assertEquals((await c.messages(gid)).length, 2);
	// the removed member cannot send any more, and a forged send is dropped by the others
	assertEquals(await codeOf(d.engine.sendMessage(gid, { text: 'x' })), 'not_active');
	const sneaky = decrypt(c.id, d.address, encryptGroup(d.id, c.address, { g: { gid, epoch: 1, t: 'msg', id: randomId(), text: 'still here?' } }))!;
	await c.engine.handle(d.address, sneaky, Date.now());
	assertEquals((await c.messages(gid)).length, 2);
	// removing someone who is not in, or the admin itself, is refused
	assertEquals(await codeOf(admin.engine.remove(gid, d.address)), 'not_member');
	assertEquals(await codeOf(admin.engine.remove(gid, admin.address)), 'transfer_first');
	assertEquals(await codeOf(b.engine.remove(gid, c.address)), 'not_admin');
});

Deno.test('ban: a banned address cannot be invited, its accept is ignored, an old invite is not replayable', async () => {
	const { net, cs, admin, gid } = await makeGroup(3);
	const [, b, c] = cs;
	const oldState = structuredClone(c.engine.get(gid)!);
	await admin.engine.ban(gid, c.address);
	await net.pump();
	assertEquals(c.engine.get(gid)?.status, 'banned');
	assertEquals(admin.engine.get(gid)?.state.banned, [c.address]);
	assertEquals(await codeOf(admin.engine.invite(gid, c.address)), 'banned');
	// the banned client tries to join again: sends accept (it is no member any more) and replays its old invite
	for (const to of [admin, b]) await to.engine.handle(c.address, decrypt(to.id, c.address, encryptGroup(c.id, to.address, { group: { op: 'accept', gid, epoch: 1 } }))!, Date.now());
	assertEquals(admin.engine.get(gid)?.state.members.includes(c.address), false);
	assertEquals(b.engine.get(gid)?.accepted.includes(c.address), false);
	const replay = encryptGroup(admin.id, c.address, { group: { op: 'invite', st: oldState.state, sig: oldState.sig } });
	const fresh = net.client('Test Fresh');
	await fresh.engine.handle(admin.address, decrypt(fresh.id, admin.address, encryptGroup(admin.id, fresh.address, { group: { op: 'invite', st: oldState.state, sig: oldState.sig } }))!, Date.now());
	assertEquals(fresh.engine.list().length, 0, 'a state without me in it never creates a group');
	await c.engine.handle(admin.address, decrypt(c.id, admin.address, replay)!, Date.now());
	assertEquals(c.engine.get(gid)?.status, 'banned', 'a stale invite (lower epoch) does nothing');
	// a banned member's messages are dropped
	await c.engine.sendMessage(gid, { text: 'let me in' }).catch(() => {});
	await net.pump();
	assertEquals((await b.messages(gid)).length, 0);
});

Deno.test('leave: the admin removes the member with a signed state; the admin cannot leave while others remain', async () => {
	const { net, cs, admin, gid } = await makeGroup(3);
	const [, b, c] = cs;
	await c.engine.leave(gid);
	await net.pump();
	assertEquals(c.engine.get(gid)?.status, 'left');
	assertEquals(admin.engine.get(gid)?.state.members.includes(c.address), false);
	assertEquals(b.engine.get(gid)?.state.members.includes(c.address), false);
	assertEquals(admin.engine.get(gid)?.state.epoch, 2);
	assertEquals(await codeOf(admin.engine.leave(gid)), 'transfer_first');
	// a non-admin cannot make anyone leave by announcing it for them
	await b.engine.leave(gid);
	await net.pump();
	assertEquals(admin.engine.get(gid)?.state.members, [admin.address]);
	await admin.engine.leave(gid);
	assertEquals(admin.engine.get(gid), undefined, 'alone: the group is simply gone');
});

Deno.test('a member cannot kick another by sending `leave` in their name', async () => {
	const { net, cs, admin, gid } = await makeGroup(3);
	const [, b, c] = cs;
	// the leave frame comes from b but names c's group state: it can only ever mean b itself
	await admin.engine.handle(b.address, decrypt(admin.id, b.address, encryptGroup(b.id, admin.address, { group: { op: 'leave', gid, epoch: 1 } }))!, Date.now());
	assertEquals(admin.engine.get(gid)?.state.members.includes(b.address), false);
	assertEquals(admin.engine.get(gid)?.state.members.includes(c.address), true);
	await net.pump();
});

Deno.test('rename and transfer admin: new admin signs from then on; the old admin is only a member', async () => {
	const { net, cs, admin, gid } = await makeGroup(3);
	const [, b, c] = cs;
	await admin.engine.rename(gid, 'Renamed Group');
	await net.pump();
	assertEquals(c.engine.get(gid)?.state.name, 'Renamed Group');
	await admin.engine.transferAdmin(gid, b.address);
	await net.pump();
	assertEquals(c.engine.get(gid)?.state.admin, b.address);
	assertEquals(await codeOf(admin.engine.rename(gid, 'Old admin')), 'not_admin');
	await b.engine.remove(gid, c.address);
	await net.pump();
	assertEquals(c.engine.get(gid)?.status, 'removed');
	assertEquals(admin.engine.get(gid)?.state.members.includes(c.address), false);
	// a state signed by the OLD admin after the transfer is rejected by everyone
	const st = { ...admin.engine.get(gid)!.state, epoch: 99, name: 'Coup' };
	const body = encryptGroup(admin.id, b.address, { group: { op: 'rename', st, sig: signState(admin.id, { ...st, admin: admin.address }) } });
	await b.engine.handle(admin.address, decrypt(b.id, admin.address, body)!, Date.now());
	assertEquals(b.engine.get(gid)?.state.name, 'Renamed Group');
});

Deno.test('a member that is behind asks the admin for the state (want) when it sees a newer epoch', async () => {
	const { net, cs, admin, gid } = await makeGroup(3);
	const [, b, c] = cs;
	// b misses the rename (offline)
	net.offline.add(b.address);
	await admin.engine.rename(gid, 'Renamed Group');
	await net.pump();
	assertEquals(b.engine.get(gid)?.state.name, 'Test Group');
	net.offline.delete(b.address);
	net.held.delete(b.address); // the update itself is lost
	await c.engine.sendMessage(gid, { text: 'new epoch here' });
	await net.pump();
	assertEquals(b.engine.get(gid)?.state.name, 'Renamed Group', 'the admin answered the want');
	assertEquals((await b.messages(gid)).length, 1);
});

// ── First contact: requests and proof of work ───────────────────────────────────────────

Deno.test('invite from a stranger is a request; proof of work rules apply; a wrong proof is filtered', async () => {
	const net = new Net();
	const [a, b] = [net.client('Test Alpha'), net.client('Test Bravo')];
	const mk = async (pow?: object, strict = false) => {
		b.strict = strict;
		b.engine.groups.clear();
		const st = state(a.address, [a.address, b.address]);
		const body = encryptGroup(a.id, b.address, { group: { op: 'invite', st, sig: signState(a.id, st) } }, pow as never);
		await b.engine.handle(a.address, decrypt(b.id, a.address, body)!, Date.now());
		return b.engine.get(st.id);
	};
	const good = solveSync(a.address, b.address, powDay());
	let rec = await mk(good);
	assertEquals([rec?.status, rec?.request, rec?.unverified], ['invited', true, undefined]);
	rec = await mk(undefined);
	assertEquals([rec?.status, rec?.request, rec?.unverified], ['invited', true, true], 'no proof: unverified badge');
	assertEquals(await mk(undefined, true), undefined, 'strict mode drops it');
	assertEquals(await mk({ v: 1, d: powDay(), n: 1 }), undefined, 'wrong proof is filtered');
	assertEquals(b.events.some((e) => e.type === 'filtered'), true);
	// a contact needs no proof and is not a request
	b.know(a);
	rec = await mk(undefined, true);
	assertEquals([rec?.status, rec?.request], ['invited', undefined]);
	// blocked: nothing
	b.blocked.add(a.address);
	assertEquals(await mk(good), undefined);
});

Deno.test('create attaches the proof of work only to the invitee it was solved for', async () => {
	const net = new Net();
	const [a, b, c] = ['Test Alpha', 'Test Bravo', 'Test Charlie'].map((n) => net.client(n));
	const pow = solveSync(a.address, b.address, powDay());
	const rec = await a.engine.create('Test Group', [b.address, c.address], { [b.address]: pow });
	await net.pump();
	const seen = net.delivered.map((w) => [w.to, decrypt(net.clients.get(w.to)!.id, w.from, w.body)?.pow !== undefined] as const);
	assertEquals(seen.find(([t]) => t === b.address)?.[1], true);
	assertEquals(seen.find(([t]) => t === c.address)?.[1], false);
	assertEquals(b.engine.get(rec.state.id)?.request, true);
	assertEquals(b.engine.get(rec.state.id)?.unverified, undefined, 'checked');
});

// ── Typing and live ─────────────────────────────────────────────────────────────────────

Deno.test('typing: nothing before accept; then ephemeral frames to online members only, never queued', async () => {
	const net = new Net();
	const [a, b, c] = ['Test Alpha', 'Test Bravo', 'Test Charlie'].map((n) => net.client(n));
	b.know(a);
	c.know(a);
	const rec = await a.engine.create('Test Group', [b.address, c.address]);
	await net.pump();
	const gid = rec.state.id;
	assertEquals(b.engine.sendTyping(gid, true), 0, 'invited, not accepted');
	await b.engine.accept(gid);
	await c.engine.accept(gid);
	await net.pump();
	net.offline.add(c.address);
	c.events.length = 0;
	b.events.length = 0;
	assertEquals(b.engine.sendTyping(gid, true), 2, 'both frames handed to the relay');
	await net.pump();
	assertEquals(net.held.get(c.address) ?? [], [], 'nothing is queued for the offline member');
	assert(a.events.some((e) => e.type === 'typing' && e.on && e.from === b.address));
	assertEquals(c.events.length, 0);
	a.engine.sendLiveText(gid, 'draft text');
	await net.pump();
	assert(b.events.some((e) => e.type === 'live' && e.text === 'draft text'));
	// from a non-member: ignored
	const x = net.client('Test Outsider');
	x.engine.groups.set(gid, a.engine.get(gid)!);
	x.engine.sendTyping(gid, true);
	b.events.length = 0;
	await net.pump();
	assertEquals(b.events.filter((e) => e.type === 'typing').length, 0);
});

// ── Delivery, retries, offline ──────────────────────────────────────────────────────────

Deno.test('offline sender keeps copies pending and retries; the relay-side id keeps it single', async () => {
	const { net, cs, gid } = await makeGroup(3);
	const [a, b, c] = cs;
	a.online = false;
	await a.engine.sendMessage(gid, { text: 'queued while offline' });
	assertEquals(a.engine.pendingCount(), 2);
	assertEquals((await b.messages(gid)).length, 0);
	a.online = true;
	a.engine.resendPending(Date.now());
	await net.pump();
	assertEquals((await b.messages(gid)).length + (await c.messages(gid)).length, 2);
	assertEquals(a.engine.pendingCount(), 0);
	// a second resend (a lost `sent`) cannot duplicate
	a.engine.resendPending(Date.now() + 120_000);
	await net.pump();
	assertEquals((await b.messages(gid)).length, 1);
});

Deno.test('delivery to an offline member waits on the relay and arrives later', async () => {
	const { net, cs, gid } = await makeGroup(3);
	const [a, , c] = cs;
	net.offline.add(c.address);
	await a.engine.sendMessage(gid, { text: 'for later' });
	await net.pump();
	assertEquals((await c.messages(gid)).length, 0);
	await net.goOnline(c.address);
	assertEquals((await c.messages(gid)).map((m) => m.text), ['for later']);
});

Deno.test('wire ids: stable per (group, message, recipient), differ per recipient', () => {
	assertEquals(wireId('a', 'm', 'x'), wireId('a', 'm', 'x'));
	assert(wireId('a', 'm', 'x') !== wireId('a', 'm', 'y'));
	assert(/^[A-Za-z0-9_-]{1,64}$/.test(wireId('a', 'm', 'x')));
});

// ── Attachments ─────────────────────────────────────────────────────────────────────────

Deno.test('attachment: the same blob metadata goes to every member, the delete token to nobody', async () => {
	const { net, cs, gid } = await makeGroup(4);
	const [a, b, c, d] = cs;
	const att = { blob: 'b'.repeat(32), key: 'c'.repeat(64), nonce: 'd'.repeat(48), hash: 'e'.repeat(64), mime: 'image/webp', size: 1234, w: 10, h: 10, thumb: '', del: 'f'.repeat(32) };
	await a.engine.sendMessage(gid, { text: 'look', att });
	await net.pump();
	for (const x of [b, c, d]) {
		const m = (await x.messages(gid))[0];
		assertEquals(m.att?.blob, att.blob);
		assertEquals(m.att?.key, att.key);
		assertEquals(m.att?.del, undefined);
	}
	assertEquals((await a.messages(gid))[0].att?.del, att.del, 'the sender keeps it');
	assertEquals(await codeOf(a.engine.sendMessage(gid, { text: '', att: { ...att, blob: 'nothex' } })), 'bad_message');
	assertEquals(await codeOf(a.engine.sendMessage(gid, { text: '   ' })), 'bad_message');
});

// ── Linked devices ──────────────────────────────────────────────────────────────────────

Deno.test('linked device: group, messages, edits, deletes and settings follow through sync, and a new device gets a snapshot', async () => {
	const { net, cs, gid } = await makeGroup(3);
	const [a, b] = cs;
	// b's second device: same account key, own store, fed by b's sync output
	const b2 = new (b.constructor as typeof b.constructor & { new (n: Net, name: string, id: typeof b.id): typeof b })(net, 'Test Bravo 2', b.id);
	net.clients.set(b.address, b); // b stays the one the relay delivers to; b2 only gets sync
	b.syncOut.length = 0;
	await b.engine.sendMessage(gid, { text: 'from device one' });
	await net.pump();
	await a.engine.sendMessage(gid, { text: 'to the account' });
	await net.pump();
	const snap = await b.engine.snapshot();
	assert(snap.some((s) => s.k === 'grp'));
	assertEquals(snap.filter((s) => s.k === 'gmsg' && !s.message.sys).length, 2);
	for (const s of snap) await b2.engine.applySync(s);
	assertEquals(b2.engine.get(gid)?.status, 'active');
	assertEquals((await b2.messages(gid)).map((m) => m.text).sort(), ['from device one', 'to the account']);
	// live sync after that: edit, delete, mute and a later membership change
	const own = (await b.messages(gid)).find((m) => m.mine)!;
	b.syncOut.length = 0;
	await b.engine.sendEdit(gid, own.id, 'edited on one');
	await b.engine.setMuted(gid, true);
	for (const s of b.syncOut) await b2.engine.applySync(s);
	assertEquals((await b2.messages(gid)).find((m) => m.id === own.id)?.text, 'edited on one');
	assertEquals(b2.engine.get(gid)?.muted, true);
	b.syncOut.length = 0;
	await b.engine.sendDelete(gid, [own.id]);
	for (const s of b.syncOut) await b2.engine.applySync(s);
	assertEquals((await b2.messages(gid)).length, 1);
	// applying everything twice changes nothing
	for (const s of snap) await b2.engine.applySync(s);
	assertEquals((await b2.messages(gid)).length, 1, 'the deleted message does not come back');
});

Deno.test('sync from a device cannot plant a group: a forged signature is ignored', async () => {
	const net = new Net();
	const [a, b] = [net.client('Test Alpha'), net.client('Test Bravo')];
	const st = state(a.address, [a.address, b.address]);
	const rec = { state: st, sig: '0'.repeat(128), signer: a.address, status: 'active' as const, accepted: [], left: [], since: 1 };
	await b.engine.applySync({ k: 'grp', rec });
	assertEquals(b.engine.list().length, 0);
	await b.engine.applySync({ k: 'grp', rec: { ...rec, sig: signState(a.id, st) } });
	assertEquals(b.engine.list().length, 1);
});

Deno.test('a restarted client keeps its groups and its undelivered copies', async () => {
	const { net, cs, gid } = await makeGroup(3);
	const [a, b] = cs;
	a.online = false;
	await a.engine.sendMessage(gid, { text: 'survive restart' });
	const again = new (a.constructor as never as { new (n: Net, name: string, id: typeof a.id): typeof a })(net, 'Test Alpha', a.id);
	again.store.groups = a.store.groups;
	again.store.messages = a.store.messages;
	again.store.out = a.store.out;
	await again.engine.init();
	net.clients.set(a.address, again);
	assertEquals(again.engine.get(gid)?.status, 'active');
	assertEquals(again.engine.pendingCount(), 2);
	again.engine.resendPending(Date.now());
	await net.pump();
	assertEquals((await b.messages(gid)).map((m) => m.text), ['survive restart']);
});

// ── Old clients ─────────────────────────────────────────────────────────────────────────

/** What v0.9.4's `decrypt` does with a payload that has no string `text` (crypto.ts, copied as it was): it needs one of these keys. */
function oldReader(p: Record<string, any>): 'dropped' | 'shown' {
	if (p?.v !== 0) return 'dropped';
	if (typeof p.text === 'string') return 'shown';
	const readable =
		cleanIds(p.del).length || cleanEdit(p.edit) || cleanPhoto(p.photo) || typeof p.live?.text === 'string' ||
		typeof p.typing === 'boolean' || cleanIds(p.ack).length || cleanIds(p.seen).length;
	return readable ? 'shown' : 'dropped';
}

Deno.test('old clients: group payloads have no `text` and no key they know, so they are dropped, never shown', async () => {
	const { net, cs, gid } = await makeGroup(3);
	const [a, b] = cs;
	await a.engine.sendMessage(gid, { text: 'secret group text' });
	await net.pump();
	assert(net.delivered.length > 0);
	for (const w of net.delivered) {
		const to = net.clients.get(w.to)!;
		// decrypt the envelope with the real keys, then run the OLD reader logic over the raw JSON
		const { xchacha20poly1305 } = await import('@noble/ciphers/chacha');
		const { x25519, edwardsToMontgomeryPriv, edwardsToMontgomeryPub } = await import('@noble/curves/ed25519');
		const { hkdf } = await import('@noble/hashes/hkdf');
		const { sha256 } = await import('@noble/hashes/sha2');
		const shared = x25519.getSharedSecret(edwardsToMontgomeryPriv(to.id.secret), edwardsToMontgomeryPub(hexToBytes(w.from)));
		const key = hkdf(sha256, shared, utf8ToBytes('miga-v0'), utf8ToBytes([to.address, w.from].sort().join('')), 32);
		const raw = Uint8Array.from(atob(w.body), (c) => c.charCodeAt(0));
		const json = JSON.parse(new TextDecoder().decode(xchacha20poly1305(key, raw.subarray(0, 24)).decrypt(raw.subarray(24))));
		assertEquals(typeof json.text, 'undefined', 'no top-level text');
		assertEquals(oldReader(json), 'dropped');
		assert(!w.body.includes('secret group text'));
	}
	void b;
});

Deno.test('old reader replica is real: it shows a plain message and a typing frame', () => {
	assertEquals(oldReader({ v: 0, text: 'hi', ts: 1 }), 'shown');
	assertEquals(oldReader({ v: 0, ts: 1, typing: true }), 'shown');
	assertEquals(oldReader({ v: 0, ts: 1, g: { gid: 'x' } }), 'dropped');
	assertEquals(oldReader({ v: 0, ts: 1, group: { op: 'accept' } }), 'dropped');
});

Deno.test('a deleted message does not come back from a late copy', async () => {
	const { net, cs, gid } = await makeGroup(3);
	const [a, b] = cs;
	const m = await a.engine.sendMessage(gid, { text: 'gone soon' });
	await net.pump();
	await a.engine.sendDelete(gid, [m.id]);
	await net.pump();
	const late = encryptGroup(a.id, b.address, { g: { gid, epoch: 1, t: 'msg', id: m.id, text: 'gone soon' } });
	await b.engine.handle(a.address, decrypt(b.id, a.address, late)!, Date.now());
	assertEquals((await b.messages(gid)).length, 0);
});

Deno.test('Ed25519 sanity: the admin address is the verification key', () => {
	const a = newIdentity();
	const sig = ed25519.sign(utf8ToBytes('x'), a.secret);
	assert(ed25519.verify(sig, utf8ToBytes('x'), hexToBytes(a.address)));
	assertEquals(bytesToHex(sig).length, 128);
});
