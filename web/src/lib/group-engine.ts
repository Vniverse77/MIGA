// The group engine: sending (fan-out), receiving, membership changes and sync with linked devices.
// It talks to the world only through `GroupDeps` (relay transport, storage, contacts), so the same code
// runs in the app and in tests with real relay clients and no browser. See docs/PROTOCOL.md, "Groups (v1)".
import type { Att } from './attach';
import { cleanAtt } from './attach';
import { cleanReply, encryptGroup, MAX_TEXT, randomId, type Identity, type Plain, type Reply } from './crypto';
import { cleanGroupMessage, cleanGroupName, MAX_GONE, cleanMentions, cleanMsgIds, cleanRecord, GroupError, isGid, isMsgId, judgeState, newState, renamed, signState, sysId, systemLines, transferred, unbanned, wireId, withMember, withoutMember, type GroupMessage, type GroupRecord, type GroupState, type GroupSync } from './groups';
import type { GroupStore, OutItem } from './group-store';
import { afterSend, FAIL_AFTER_MS, nextStep, type Track } from './outbox';
import type { Pow } from './pow';
import { classify } from './requests';
import type { Contact } from './storage';

export type GroupTransport = {
	/** Queue a copy on the relay. False when offline (the engine keeps it and retries). */
	send(to: string, id: string, body: string): boolean;
	/** Ephemeral frame, online members only, never queued. */
	sendLive(to: string, body: string): boolean;
	/** Copy to my other devices (the host seals it with the account sync key). */
	syncAll(message: GroupSync): void;
};

export type GroupDeps = {
	me: Identity;
	transport: GroupTransport;
	store: GroupStore;
	contactOf(address: string): Pick<Contact, 'request' | 'unverified'> | undefined;
	isBlocked(address: string): boolean;
	strict(): boolean;
	/** My shared display name for group messages (sender chose to share it), if any. */
	ownName?(): string | undefined;
	now?(): number;
};

/** How loudly a received message should notify. `mention`: the group is muted but I am named. */
export type Notify = 'normal' | 'mention' | 'silent';

export type GroupEvent =
	| { type: 'group'; gid: string; record: GroupRecord }
	| { type: 'request'; gid: string }
	| { type: 'filtered'; gid: string }
	| { type: 'message'; gid: string; message: GroupMessage; notify: Notify }
	| { type: 'edited' | 'deleted'; gid: string; ids: string[] }
	| { type: 'typing'; gid: string; from: string; on: boolean }
	| { type: 'live'; gid: string; from: string; text: string };

export class GroupEngine {
	groups = new Map<string, GroupRecord>();
	private out = new Map<string, OutItem>();
	private track = new Map<string, Track>();
	private chain: Promise<unknown> = Promise.resolve();
	private ephTs = new Map<string, number>();
	onEvent: (e: GroupEvent) => void = () => {};

	constructor(private d: GroupDeps) {}

	private now = () => this.d.now?.() ?? Date.now();
	private get me() {
		return this.d.me.address;
	}

	/** Runs `fn` after everything queued before it: handlers and senders never interleave. */
	private run<T>(fn: () => Promise<T>): Promise<T> {
		const p = this.chain.then(fn);
		this.chain = p.catch(() => {});
		return p;
	}

	async init(): Promise<void> {
		return this.run(async () => {
			for (const g of await this.d.store.loadGroups()) {
				const rec = cleanRecord(g);
				if (rec) this.groups.set(rec.state.id, rec);
			}
			for (const o of await this.d.store.loadOut()) this.out.set(o.wid, o);
		});
	}

	// ── Queries (synchronous, from memory) ──────────────────────────────────────────────────

	get(gid: string): GroupRecord | undefined {
		return this.groups.get(gid);
	}
	list(): GroupRecord[] {
		return [...this.groups.values()].sort((a, b) => b.since - a.since);
	}
	/** Open invites (Requests). */
	invites(): GroupRecord[] {
		return this.list().filter((g) => g.status === 'invited');
	}
	/** Content messages only (no system lines). */
	async messages(gid: string): Promise<GroupMessage[]> {
		return (await this.d.store.listMessages(gid)).filter((m) => !m.sys);
	}
	/** Everything in order, including system lines ("A added B"): what the chat shows. */
	timeline(gid: string): Promise<GroupMessage[]> {
		return this.d.store.listMessages(gid);
	}
	/** Members that must get a copy of what I send: everyone in the group but me. */
	recipients(gid: string): string[] {
		return (this.groups.get(gid)?.state.members ?? []).filter((m) => m !== this.me);
	}
	/** Copies not yet confirmed by the relay (tests, status line). */
	pendingCount(): number {
		return this.out.size;
	}

	// ── Internal helpers ────────────────────────────────────────────────────────────────────

	private async save(rec: GroupRecord, sync = true): Promise<void> {
		const before = this.groups.get(rec.state.id);
		this.groups.set(rec.state.id, rec);
		await this.d.store.putGroup(rec);
		await this.writeSys(before, rec);
		if (sync) this.d.transport.syncAll({ k: 'grp', rec });
		this.onEvent({ type: 'group', gid: rec.state.id, record: rec });
	}

	/** Stores the system lines of a state change. The id is derived, so a second device (or a replay) writes the same row. */
	private async writeSys(before: GroupRecord | undefined, rec: GroupRecord): Promise<void> {
		const gid = rec.state.id;
		for (const { epoch, line } of systemLines(before, rec)) {
			const id = sysId(gid, epoch, line);
			if (rec.gone?.includes(id) || (await this.d.store.getMessage(gid, id))) continue;
			const msg: GroupMessage = { gid, id, from: rec.state.admin, mine: false, text: '', ts: this.now(), sys: line };
			await this.d.store.putMessage(msg);
			this.onEvent({ type: 'message', gid, message: msg, notify: 'silent' });
		}
	}

	private async enqueue(to: string, gid: string, payload: OutItem['payload'], extra: { mid?: string; pow?: Pow } = {}): Promise<void> {
		const wid = wireId(gid, randomId(), to);
		const item: OutItem = { wid, to, gid, payload, ts: this.now(), ...(extra.mid ? { mid: extra.mid } : {}), ...(extra.pow ? { pow: extra.pow } : {}) };
		await this.d.store.putOut(item);
		this.out.set(wid, item);
		this.attempt(item, this.now());
	}

	/** Content copies use one relay id per (message, member) so a retry is a duplicate for the relay. */
	private async enqueueMsg(to: string, gid: string, mid: string, payload: OutItem['payload']): Promise<void> {
		const wid = wireId(gid, mid, to);
		const item: OutItem = { wid, to, gid, mid, payload, ts: this.now() };
		await this.d.store.putOut(item);
		this.out.set(wid, item);
		this.attempt(item, this.now());
	}

	private attempt(item: OutItem, now: number): void {
		const step = nextStep({ state: 'pending', ts: item.ts }, this.track.get(item.wid), now);
		if (step === 'fail') {
			void this.fail(item);
			return;
		}
		if (step !== 'send') return;
		const body = encryptGroup(this.d.me, item.to, item.payload, item.pow);
		if (this.d.transport.send(item.to, item.wid, body)) this.track.set(item.wid, afterSend(this.track.get(item.wid), now));
	}

	private async fail(item: OutItem): Promise<void> {
		this.out.delete(item.wid);
		this.track.delete(item.wid);
		await this.d.store.deleteOut(item.wid);
		if (item.mid) {
			const m = await this.d.store.getMessage(item.gid, item.mid);
			if (m?.to?.[item.to]) {
				m.to[item.to] = 'failed';
				await this.d.store.putMessage(m);
			}
		}
	}

	/** Call after every (re)connect and on a timer: sends what is due. */
	resendPending(now = this.now()): void {
		for (const item of this.out.values()) {
			if (now - item.ts >= FAIL_AFTER_MS) void this.fail(item);
			else this.attempt(item, now);
		}
	}

	/** The relay confirmed copy `wid`. Returns the message it belonged to, if any. */
	onSent(wid: string): Promise<{ gid: string; mid: string } | null> {
		return this.run(async () => {
			const item = this.out.get(wid);
			if (!item) return null;
			this.out.delete(wid);
			this.track.delete(wid);
			await this.d.store.deleteOut(wid);
			if (!item.mid) return null;
			const m = await this.d.store.getMessage(item.gid, item.mid);
			if (m?.to) {
				m.to[item.to] = 'sent';
				await this.d.store.putMessage(m);
				this.d.transport.syncAll({ k: 'gmsg', gid: item.gid, message: m });
			}
			return { gid: item.gid, mid: item.mid };
		});
	}

	/** Is this relay id one of ours (so the host does not treat it as a 1:1 message)? */
	owns(wid: string): boolean {
		return this.out.has(wid);
	}

	private admin(gid: string): GroupRecord {
		const rec = this.groups.get(gid);
		if (!rec) throw new GroupError('unknown_group');
		if (rec.state.admin !== this.me || rec.status !== 'active') throw new GroupError('not_admin');
		return rec;
	}

	/** Signs `next`, stores it and sends it to its members and to `also` (removed addresses). */
	private async publish(rec: GroupRecord, next: GroupState, op: string, also: string[] = [], pows: Record<string, Pow> = {}): Promise<GroupRecord> {
		const sig = signState(this.d.me, next, rec.state.admin);
		const updated: GroupRecord = {
			...rec,
			state: next,
			sig,
			signer: this.me,
			accepted: rec.accepted.filter((a) => next.members.includes(a)),
			left: rec.left.filter((a) => next.members.includes(a))
		};
		await this.save(updated);
		const payload = { group: { op, st: next, sig } };
		for (const to of [...next.members.filter((m) => m !== this.me), ...also]) {
			await this.enqueue(to, next.id, payload, pows[to] ? { pow: pows[to] } : {});
		}
		return updated;
	}

	// ── Membership, as admin ────────────────────────────────────────────────────────────────

	/** Makes a group and invites `invitees` (at most 4). `pows`: proof of work for invitees that never wrote to me. */
	create(name: string, invitees: string[] = [], pows: Record<string, Pow> = {}, id?: string): Promise<GroupRecord> {
		return this.run(async () => {
			const gid = id && isGid(id) ? id : randomId();
			let st = newState(this.me, name, this.now(), gid);
			for (const a of new Set(invitees)) st = withMember(st, a);
			st = { ...st, epoch: 1 };
			const rec: GroupRecord = { state: st, sig: signState(this.d.me, st), signer: this.me, status: 'active', accepted: [this.me], left: [], since: this.now() };
			await this.save(rec);
			const payload = { group: { op: 'invite', st, sig: rec.sig } };
			for (const to of st.members.filter((m) => m !== this.me)) await this.enqueue(to, gid, payload, pows[to] ? { pow: pows[to] } : {});
			return rec;
		});
	}

	invite(gid: string, address: string, pow?: Pow): Promise<GroupRecord> {
		return this.run(async () => {
			const rec = this.admin(gid);
			return this.publish(rec, withMember(rec.state, address), 'invite', [], pow ? { [address]: pow } : {});
		});
	}

	remove(gid: string, address: string): Promise<GroupRecord> {
		return this.run(async () => {
			const rec = this.admin(gid);
			return this.publish(rec, withoutMember(rec.state, address), 'remove', [address]);
		});
	}

	ban(gid: string, address: string): Promise<GroupRecord> {
		return this.run(async () => {
			const rec = this.admin(gid);
			return this.publish(rec, withoutMember(rec.state, address, true), 'ban', [address]);
		});
	}

	rename(gid: string, name: string): Promise<GroupRecord> {
		return this.run(async () => {
			const rec = this.admin(gid);
			return this.publish(rec, renamed(rec.state, name), 'rename');
		});
	}

	unban(gid: string, address: string): Promise<GroupRecord> {
		return this.run(async () => {
			const rec = this.admin(gid);
			return this.publish(rec, unbanned(rec.state, address), 'unban');
		});
	}

	transferAdmin(gid: string, to: string): Promise<GroupRecord> {
		return this.run(async () => {
			const rec = this.admin(gid);
			// Signed by the old admin (the key receivers know); the new admin signs from the next change on.
			return this.publish(rec, transferred(rec.state, to), 'transfer');
		});
	}

	// ── Membership, as member ───────────────────────────────────────────────────────────────

	accept(gid: string): Promise<GroupRecord> {
		return this.run(async () => {
			const rec = this.groups.get(gid);
			if (!rec) throw new GroupError('unknown_group');
			if (rec.status !== 'invited') throw new GroupError('not_active');
			const updated: GroupRecord = { ...rec, status: 'active', request: undefined, unverified: undefined, accepted: [...new Set([...rec.accepted, this.me])].sort() };
			delete updated.request;
			delete updated.unverified;
			await this.save(updated);
			const payload = { group: { op: 'accept', gid, epoch: rec.state.epoch } };
			for (const to of rec.state.members.filter((m) => m !== this.me)) await this.enqueue(to, gid, payload);
			return updated;
		});
	}

	/** Leave an active group or decline an invite. The admin must transfer first unless alone. */
	leave(gid: string): Promise<void> {
		return this.run(async () => {
			const rec = this.groups.get(gid);
			if (!rec) throw new GroupError('unknown_group');
			if (rec.status !== 'active' && rec.status !== 'invited') throw new GroupError('not_active');
			const others = rec.state.members.filter((m) => m !== this.me);
			if (rec.state.admin === this.me && others.length) throw new GroupError('transfer_first');
			const payload = { group: { op: 'leave', gid, epoch: rec.state.epoch } };
			for (const to of others) await this.enqueue(to, gid, payload);
			if (!others.length) {
				await this.dropGroup(gid);
				return;
			}
			await this.save({ ...rec, status: 'left' });
		});
	}

	/** Forgets a group that is over (alone, or left/removed and no longer wanted). Keeps nothing, not even the replay guard and not copies still queued (wait for `pendingCount()` to drop after a leave). */
	deleteLocal(gid: string): Promise<void> {
		return this.run(() => this.dropGroup(gid));
	}

	private async dropGroup(gid: string): Promise<void> {
		this.groups.delete(gid);
		for (const [w, o] of this.out) if (o.gid === gid) (this.out.delete(w), this.track.delete(w));
		await this.d.store.deleteGroup(gid);
	}

	setMuted(gid: string, muted: boolean): Promise<void> {
		return this.run(async () => {
			const rec = this.groups.get(gid);
			if (!rec) throw new GroupError('unknown_group');
			const updated = { ...rec };
			if (muted) updated.muted = true;
			else delete updated.muted;
			await this.save(updated);
		});
	}

	// ── Sending content ─────────────────────────────────────────────────────────────────────

	private activeOrThrow(gid: string): GroupRecord {
		const rec = this.groups.get(gid);
		if (!rec) throw new GroupError('unknown_group');
		if (rec.status !== 'active') throw new GroupError('not_active');
		return rec;
	}

	private async fanOut(rec: GroupRecord, t: string, fields: object, mid?: string): Promise<void> {
		const base = { gid: rec.state.id, epoch: rec.state.epoch, t };
		for (const to of rec.state.members.filter((m) => m !== this.me)) {
			if (mid) await this.enqueueMsg(to, rec.state.id, mid, { g: { ...base, id: mid, ...fields } });
			else await this.enqueue(to, rec.state.id, { g: { ...base, ...fields } });
		}
	}

	/** `att` must already be uploaded (once); the same metadata goes into every member's envelope. */
	sendMessage(gid: string, input: { text: string; att?: Att; reply?: Reply; mentions?: string[] }): Promise<GroupMessage> {
		return this.run(async () => {
			const rec = this.activeOrThrow(gid);
			const text = input.text.slice(0, MAX_TEXT);
			if (!text.trim() && !input.att) throw new GroupError('bad_message');
			const att = input.att ? cleanAtt(input.att, true) : null;
			if (input.att && !att) throw new GroupError('bad_message');
			const reply = input.reply ? cleanReply(input.reply) : null;
			const mentions = cleanMentions(input.mentions, rec.state.members).filter((a) => a !== this.me);
			const name = this.d.ownName?.();
			const id = randomId();
			const to: NonNullable<GroupMessage['to']> = {};
			for (const r of this.recipients(gid)) to[r] = 'pending';
			const message: GroupMessage = {
				gid, id, from: this.me, mine: true, text, ts: this.now(),
				...(att ? { att } : {}), ...(reply ? { reply } : {}), ...(mentions.length ? { mentions } : {}), ...(name ? { name } : {}), to
			};
			await this.d.store.putMessage(message);
			this.d.transport.syncAll({ k: 'gmsg', gid, message });
			await this.fanOut(rec, 'msg', {
				text,
				...(att ? { att: { ...att, del: undefined } } : {}),
				...(reply ? { reply } : {}),
				...(mentions.length ? { mentions } : {}),
				...(name ? { name } : {})
			}, id);
			return message;
		});
	}

	sendEdit(gid: string, id: string, text: string): Promise<boolean> {
		return this.run(async () => {
			const rec = this.activeOrThrow(gid);
			const m = await this.d.store.getMessage(gid, id);
			const clean = text.trim().slice(0, MAX_TEXT);
			if (!m || !m.mine || !clean) return false;
			const ts = this.now();
			m.text = clean;
			m.edited = ts;
			await this.d.store.putMessage(m);
			this.d.transport.syncAll({ k: 'gedit', gid, id, text: clean, ts });
			await this.fanOut(rec, 'edit', { eid: id, text: clean });
			return true;
		});
	}

	/** Delete for everyone: only my own messages. Returns the removed ones (the caller deletes their blobs). */
	sendDelete(gid: string, ids: string[]): Promise<GroupMessage[]> {
		return this.run(async () => {
			const rec = this.activeOrThrow(gid);
			const gone: GroupMessage[] = [];
			for (const id of cleanMsgIds(ids)) {
				const m = await this.d.store.getMessage(gid, id);
				if (m?.mine) {
					await this.d.store.deleteMessage(gid, id);
					gone.push(m);
				}
			}
			if (gone.length) {
				const list = gone.map((m) => m.id);
				await this.remember(gid, list);
				this.d.transport.syncAll({ k: 'gdel', gid, ids: list });
				await this.fanOut(rec, 'del', { ids: list });
				// Copies of the deleted messages that never left must not leave now.
				for (const [w, o] of this.out) if (o.mid && list.includes(o.mid)) (this.out.delete(w), this.track.delete(w), await this.d.store.deleteOut(w));
			}
			return gone;
		});
	}

	/** Delete for me: local only (also other devices), nothing is sent to the group. */
	deleteForMe(gid: string, ids: string[]): Promise<void> {
		return this.run(async () => {
			const list = cleanMsgIds(ids);
			for (const id of list) await this.d.store.deleteMessage(gid, id);
			await this.remember(gid, list);
			if (list.length) this.d.transport.syncAll({ k: 'gdel', gid, ids: list });
		});
	}

	/** Ephemeral typing frame to members that are online right now. Nothing before I accepted. Returns the frames handed to the relay. */
	sendTyping(gid: string, on: boolean): number {
		return this.live(gid, 'typing', { on });
	}
	sendLiveText(gid: string, text: string): number {
		return this.live(gid, 'live', { text: text.slice(0, MAX_TEXT) });
	}
	private live(gid: string, t: string, fields: object): number {
		const rec = this.groups.get(gid);
		if (!rec || rec.status !== 'active') return 0;
		let n = 0;
		for (const to of this.recipients(gid)) {
			const body = encryptGroup(this.d.me, to, { g: { gid, epoch: rec.state.epoch, t, ...fields } });
			if (this.d.transport.sendLive(to, body)) n++;
		}
		return n;
	}

	// ── Receiving ───────────────────────────────────────────────────────────────────────────

	/**
	 * A normal (queued) relay message that carries `group` or `g`. Always resolves (the caller then
	 * acknowledges it): unknown, forged or stale input is dropped without a trace.
	 */
	handle(from: string, plain: Plain, ts: number): Promise<void> {
		return this.run(async () => {
			if (this.d.isBlocked(from) || from === this.me) return;
			if (plain.group) await this.handleControl(from, plain.group, plain.pow, ts);
			else if (plain.g) await this.handleContent(from, plain.g, ts);
		});
	}

	/** An ephemeral frame (typing / live). Order is by the sender's clock, like 1:1 typing. */
	handleLive(from: string, plain: Plain): void {
		const g = plain.g;
		if (!g || this.d.isBlocked(from) || !isGid(g.gid)) return;
		const rec = this.groups.get(g.gid);
		if (!rec || rec.status !== 'active' || !this.fromMember(rec, from)) return;
		if (plain.ts < (this.ephTs.get(from + g.gid) ?? 0)) return;
		this.ephTs.set(from + g.gid, plain.ts);
		if (g.t === 'typing' && typeof g.on === 'boolean') this.onEvent({ type: 'typing', gid: g.gid, from, on: g.on });
		else if (g.t === 'live' && typeof g.text === 'string') this.onEvent({ type: 'live', gid: g.gid, from, text: g.text.slice(0, MAX_TEXT) });
	}

	private fromMember(rec: GroupRecord, from: string): boolean {
		return from !== this.me && rec.state.members.includes(from) && !rec.state.banned.includes(from) && !rec.left.includes(from);
	}

	private async handleControl(from: string, group: Record<string, unknown>, pow: Pow | undefined, ts: number): Promise<void> {
		if (group.st !== undefined) return this.handleState(from, group, pow, ts, false);
		const gid = group.gid;
		if (!isGid(gid)) return;
		const rec = this.groups.get(gid);
		if (!rec) return;
		const member = rec.state.members.includes(from) && !rec.state.banned.includes(from);
		if (group.op === 'accept') {
			if (!member || rec.accepted.includes(from)) return;
			await this.save({ ...rec, accepted: [...rec.accepted, from].sort() }, false);
		} else if (group.op === 'leave') {
			if (!member || from === rec.state.admin || rec.left.includes(from)) return;
			const marked = { ...rec, left: [...rec.left, from] };
			// The admin turns the announcement into a signed state; everybody else waits for it.
			if (rec.state.admin === this.me && rec.status === 'active') {
				await this.save(marked, false); // so the system line reads "left", not "removed"
				await this.publish(marked, withoutMember(rec.state, from), 'remove', [from]);
			} else await this.save(marked, false);
		} else if (group.op === 'want') {
			if (rec.state.admin === this.me && rec.status === 'active' && member) {
				await this.enqueue(from, gid, { group: { op: 'update', st: rec.state, sig: rec.sig } });
			}
		}
	}

	private async handleState(from: string, group: Record<string, unknown>, pow: Pow | undefined, ts: number, viaSync: boolean): Promise<void> {
		const known = this.groups.get(String((group.st as { id?: unknown } | undefined)?.id));
		const verdict = judgeState(known, { st: group.st, sig: group.sig }, from, viaSync);
		if (!verdict.ok) return;
		const st = verdict.state;
		const sig = group.sig as string;
		if (!st.members.includes(this.me)) {
			// Removed or banned. An unknown group I was never in is not stored.
			if (!known) return;
			await this.save({ ...known, state: st, sig, signer: known.state.admin, status: known.status === 'left' ? 'left' : st.banned.includes(this.me) ? 'banned' : 'removed', accepted: [], left: [] }, !viaSync);
			return;
		}
		if (known) {
			const back = known.status === 'removed' || known.status === 'banned' || known.status === 'left';
			await this.save({
				...known, state: st, sig, signer: known.state.admin,
				status: back ? 'invited' : known.status,
				accepted: known.accepted.filter((a) => st.members.includes(a)),
				left: known.left.filter((a) => st.members.includes(a))
			}, !viaSync);
			return;
		}
		// A new invite. A stranger's goes through the same first-contact rules as a first message.
		const verdictReq = classify({ contact: this.d.contactOf(from), pow, from, me: this.me, ts, strict: this.d.strict() });
		if (verdictReq === 'filtered') {
			this.onEvent({ type: 'filtered', gid: st.id });
			return;
		}
		const rec: GroupRecord = {
			state: st, sig, signer: st.admin, status: 'invited', accepted: [st.admin], left: [], since: this.now(),
			...(verdictReq !== 'contact' ? { request: true } : {}), ...(verdictReq === 'unverified' ? { unverified: true } : {})
		};
		await this.save(rec, !viaSync);
		if (rec.request) this.onEvent({ type: 'request', gid: st.id });
	}

	private async handleContent(from: string, g: Record<string, unknown>, ts: number): Promise<void> {
		if (!isGid(g.gid)) return;
		const gid = g.gid;
		const rec = this.groups.get(gid);
		if (!rec || (rec.status !== 'active' && rec.status !== 'invited') || !this.fromMember(rec, from)) return;
		const epoch = Number(g.epoch);
		if (epoch > rec.state.epoch && (rec.wanted ?? 0) < epoch && rec.state.admin !== this.me) {
			// The sender knows a newer state than I do: ask the admin for it, once per epoch.
			await this.save({ ...rec, wanted: epoch }, false);
			await this.enqueue(rec.state.admin, gid, { group: { op: 'want', gid, epoch: rec.state.epoch } });
		}
		if (g.t === 'msg') {
			if (!isMsgId(g.id) || typeof g.text !== 'string' || g.text.length > MAX_TEXT) return;
			if (rec.gone?.includes(g.id) || (await this.d.store.getMessage(gid, g.id))) return;
			const att = g.att === undefined ? null : cleanAtt(g.att);
			if (g.att !== undefined && !att) return;
			if (!g.text.trim() && !att) return;
			const mentions = cleanMentions(g.mentions, rec.state.members);
			const mentionsMe = mentions.includes(this.me);
			const reply = cleanReply(g.reply);
			const name = typeof g.name === 'string' && g.name.trim() ? cleanGroupName(g.name) : '';
			const message: GroupMessage = {
				gid, id: g.id, from, mine: false, text: g.text, ts,
				...(att ? { att } : {}), ...(reply ? { reply } : {}), ...(mentions.length ? { mentions } : {}),
				...(mentionsMe ? { mentionsMe: true } : {}), ...(name ? { name } : {})
			};
			await this.d.store.putMessage(message);
			this.d.transport.syncAll({ k: 'gmsg', gid, message });
			const notify: Notify = rec.status === 'invited' ? 'silent' : rec.muted ? (mentionsMe ? 'mention' : 'silent') : 'normal';
			this.onEvent({ type: 'message', gid, message, notify });
		} else if (g.t === 'edit') {
			if (!isMsgId(g.eid) || typeof g.text !== 'string' || !g.text.trim() || g.text.length > MAX_TEXT) return;
			await this.applyEdit(gid, g.eid, from, g.text.trim(), ts, true);
		} else if (g.t === 'del') {
			const gone: string[] = [];
			for (const id of cleanMsgIds(g.ids)) {
				const m = await this.d.store.getMessage(gid, id);
				// Delete for everyone is author-only: the sender must be the author of that very message.
				if (m && !m.mine && m.from === from) {
					await this.d.store.deleteMessage(gid, id);
					gone.push(id);
				} else if (!m) {
					await this.remember(gid, [id]); // the delete overtook the message
				}
			}
			await this.remember(gid, gone);
			if (gone.length) {
				this.d.transport.syncAll({ k: 'gdel', gid, ids: gone });
				this.onEvent({ type: 'deleted', gid, ids: gone });
			}
		}
	}

	/** Remembers deleted ids so a late copy of the message cannot come back. */
	private async remember(gid: string, ids: string[]): Promise<void> {
		const rec = this.groups.get(gid);
		if (!rec || !ids.length) return;
		const gone = [...new Set([...(rec.gone ?? []), ...ids])].slice(-MAX_GONE);
		this.groups.set(gid, { ...rec, gone });
		await this.d.store.putGroup({ ...rec, gone });
	}

	private async applyEdit(gid: string, id: string, author: string, text: string, ts: number, sync: boolean): Promise<void> {
		const m = await this.d.store.getMessage(gid, id);
		if (!m || m.from !== author || ts <= (m.edited ?? 0)) return;
		m.text = text;
		m.edited = ts;
		await this.d.store.putMessage(m);
		if (sync) this.d.transport.syncAll({ k: 'gedit', gid, id, text, ts });
		this.onEvent({ type: 'edited', gid, ids: [id] });
	}

	// ── Linked devices ──────────────────────────────────────────────────────────────────────

	/** A sync message from one of my own devices. */
	applySync(m: GroupSync): Promise<void> {
		return this.run(async () => {
			if (m.k === 'grp') {
				const rec = cleanRecord(m.rec);
				if (!rec) return;
				const known = this.groups.get(rec.state.id);
				if (!known) return void (await this.save(rec, false));
				if (rec.state.epoch > known.state.epoch) {
					// A newer state must chain from the admin this device already knows (own device: sender check skipped).
					if (!judgeState(known, { st: rec.state, sig: rec.sig }, this.me, true).ok) return;
					return void (await this.save({ ...rec, muted: known.muted ?? rec.muted }, false));
				}
				if (rec.state.epoch < known.state.epoch) return;
				// Same state: merge the local facts. A way out (left/removed) and "active" win over "invited".
				const rank = { invited: 0, active: 1, removed: 2, banned: 2, left: 2 } as const;
				const status = rank[rec.status] > rank[known.status] ? rec.status : known.status;
				const merged: GroupRecord = {
					...known, status,
					accepted: [...new Set([...known.accepted, ...rec.accepted])].sort(),
					left: [...new Set([...known.left, ...rec.left])].sort(),
					...(rec.muted !== undefined || known.muted ? { muted: rec.muted } : {})
				};
				if (merged.status !== 'invited') { delete merged.request; delete merged.unverified; }
				if (JSON.stringify(merged) !== JSON.stringify(known)) await this.save(merged, false);
			} else if (m.k === 'gmsg') {
				const rec = this.groups.get(String(m.gid));
				if (!rec) return;
				const msg = cleanGroupMessage(m.message, rec.state.id, [...rec.state.members, ...rec.state.banned, ...(m.message?.from ? [String(m.message.from)] : [])]);
				if (!msg) return;
				if (rec.gone?.includes(msg.id)) return;
				const have = await this.d.store.getMessage(rec.state.id, msg.id);
				// A duplicate is dropped, except that an own message gains delivery ticks from the other device.
				if (have) {
					if (have.mine && msg.mine && msg.to) {
						have.to = { ...have.to, ...Object.fromEntries(Object.entries(msg.to).filter(([k, v]) => v === 'sent' || !have.to?.[k])) };
						await this.d.store.putMessage(have);
					}
					return;
				}
				await this.d.store.putMessage(msg);
				this.onEvent({ type: 'message', gid: msg.gid, message: msg, notify: 'silent' });
			} else if (m.k === 'gdel') {
				if (!isGid(m.gid)) return;
				const ids = cleanMsgIds(m.ids);
				for (const id of ids) await this.d.store.deleteMessage(m.gid, id);
				await this.remember(m.gid, ids);
				if (ids.length) this.onEvent({ type: 'deleted', gid: m.gid, ids });
			} else if (m.k === 'gedit') {
				if (!isGid(m.gid) || !isMsgId(m.id) || typeof m.text !== 'string') return;
				const have = await this.d.store.getMessage(m.gid, m.id);
				if (have) await this.applyEdit(m.gid, m.id, have.from, m.text.trim().slice(0, MAX_TEXT), Number(m.ts) || this.now(), false);
			}
		});
	}

	/** Everything a new linked device needs: the group records, then their messages. Sent over sync. */
	snapshot(): Promise<GroupSync[]> {
		return this.run(async () => {
			const items: GroupSync[] = this.list().map((rec) => ({ k: 'grp' as const, rec }));
			for (const rec of this.list()) {
				for (const message of await this.d.store.listMessages(rec.state.id)) items.push({ k: 'gmsg', gid: rec.state.id, message });
			}
			return items;
		});
	}
}

export { GroupError };
