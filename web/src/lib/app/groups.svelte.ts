// The group screens' state: one GroupEngine, its records and the open timeline as reactive state.
// Messenger.svelte owns the relay and the account; this class owns everything that is only about groups.
// Protocol and rules: docs/PROTOCOL.md, "Groups (v1)"; the engine does the work, this class mirrors it for the UI.
import { GroupEngine, type GroupEvent, type GroupTransport, type Notify } from '../group-engine';
import { IdbGroupStore } from '../group-store';
import type { Identity, Plain } from '../crypto';
import type { GroupMessage, GroupRecord, GroupSync } from '../groups';
import type { Contact } from '../storage';
import { TYPING_EXPIRE_MS } from '../typing';

const KEY_UNREAD = 'miga.gunread';

export type GroupUnread = { n: number; at: boolean };

export type GroupHost = {
	me: Identity;
	send: GroupTransport['send'];
	sendLive: GroupTransport['sendLive'];
	syncAll(m: GroupSync): void;
	contactOf(address: string): Contact | undefined;
	isBlocked(address: string): boolean;
	strict(): boolean;
	ownName(): string | undefined;
	/** The group chat is open and on screen right now. */
	viewing(gid: string): boolean;
	/** A message arrived that should be announced (never for a group that is being read). */
	announce(rec: GroupRecord, message: GroupMessage, notify: Notify): void;
	/** A group invite from someone who is not a contact (the Requests row and its notification). */
	invited(rec: GroupRecord): void;
};

const readUnread = (): Record<string, GroupUnread> => {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY_UNREAD) ?? '{}') as Record<string, GroupUnread>;
		return Object.fromEntries(Object.entries(raw).filter(([k, v]) => /^[0-9a-f]{32}$/.test(k) && v && v.n > 0));
	} catch {
		return {};
	}
};

export class GroupsController {
	engine: GroupEngine;
	/** Every record, newest first. */
	records = $state.raw<GroupRecord[]>([]);
	/** The open group's timeline: messages and system lines. */
	timeline = $state.raw<GroupMessage[]>([]);
	/** Newest message (not a system line) per group, for the chat list. */
	last = $state.raw<Record<string, GroupMessage | undefined>>({});
	/** Who is typing right now, per group (addresses). */
	typing = $state.raw<Record<string, string[]>>({});
	unread = $state<Record<string, GroupUnread>>(readUnread());
	/** Names people shared inside groups (they are not contacts), by address. */
	sharedNames = $state.raw<Record<string, string>>({});
	/** Set by the host: the open chat (a gid or an address). */
	open: string | null = null;
	ready: Promise<void>;
	private timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private h: GroupHost) {
		this.engine = new GroupEngine({
			me: h.me,
			store: new IdbGroupStore(),
			transport: { send: h.send, sendLive: h.sendLive, syncAll: h.syncAll },
			contactOf: (a) => h.contactOf(a),
			isBlocked: (a) => h.isBlocked(a),
			strict: () => h.strict(),
			ownName: () => h.ownName()
		});
		this.engine.onEvent = (e) => void this.onEvent(e);
		this.ready = this.engine.init().then(async () => {
			// A group I left: its leave copies are on the wire; the record goes once they are out.
			this.records = this.engine.list();
			for (const rec of this.records) if (rec.status === 'left') this.tidy(rec.state.id);
			await this.reloadLast();
		});
	}

	get(gid: string): GroupRecord | undefined {
		return this.records.find((r) => r.state.id === gid);
	}
	/** Records shown in the chat list: groups I am in, plus ones I was removed from (read only until I delete them). */
	get chats(): GroupRecord[] {
		return this.records.filter((r) => r.status !== 'invited' && r.status !== 'left');
	}
	get invites(): GroupRecord[] {
		return this.records.filter((r) => r.status === 'invited');
	}

	/** Name of a member: my contact name, else the name they shared in a group, else a short address. */
	nameOf = (address: string): string => {
		if (address === this.h.me.address) return '';
		const c = this.h.contactOf(address);
		return c?.name ?? this.sharedNames[address] ?? 'user ' + address.slice(0, 6);
	};

	private async reloadLast(): Promise<void> {
		const last: Record<string, GroupMessage | undefined> = {};
		const names: Record<string, string> = {};
		for (const rec of this.records) {
			const list = await this.engine.timeline(rec.state.id);
			last[rec.state.id] = list.findLast((m) => !m.sys) ?? list.at(-1);
			for (const m of list) if (m.name && !m.mine) names[m.from] = m.name;
		}
		this.last = last;
		this.sharedNames = { ...this.sharedNames, ...names };
	}

	async reloadTimeline(): Promise<void> {
		const gid = this.open;
		this.timeline = gid && this.get(gid) ? await this.engine.timeline(gid) : [];
	}

	private persistUnread(): void {
		try {
			localStorage.setItem(KEY_UNREAD, JSON.stringify($state.snapshot(this.unread)));
		} catch {
			// Not remembered across a reload; the counters still work.
		}
	}

	clearUnread(gid: string): void {
		if (!this.unread[gid]) return;
		delete this.unread[gid];
		this.persistUnread();
	}

	private async onEvent(e: GroupEvent): Promise<void> {
		this.records = this.engine.list();
		if (e.type === 'group') {
			if (this.open === e.gid) await this.reloadTimeline();
			const rec = this.get(e.gid);
			if (rec?.status === 'left') this.tidy(e.gid);
			return;
		}
		if (e.type === 'request') {
			const rec = this.get(e.gid);
			if (rec) this.h.invited(rec);
			return;
		}
		if (e.type === 'filtered') return;
		if (e.type === 'typing') return this.setTyping(e.gid, e.from, e.on);
		if (e.type === 'live') return this.setTyping(e.gid, e.from, e.text.length > 0);
		if (e.type === 'message') {
			if (e.message.name && !e.message.mine) this.sharedNames = { ...this.sharedNames, [e.message.from]: e.message.name };
			if (!e.message.sys) {
				this.last = { ...this.last, [e.gid]: e.message };
				this.setTyping(e.gid, e.message.from, false);
				const rec = this.get(e.gid);
				if (rec && rec.status === 'active' && !e.message.mine) {
					const seen = this.h.viewing(e.gid);
					// Counted when not being read (a muted group counts quietly); announced unless silent.
					if (!seen) {
						const u = this.unread[e.gid] ?? { n: 0, at: false };
						this.unread[e.gid] = { n: u.n + 1, at: u.at || !!e.message.mentionsMe };
						this.persistUnread();
					}
					if (e.notify !== 'silent' && !(seen && document.hasFocus())) this.h.announce(rec, e.message, e.notify);
				}
			}
		}
		if (this.open === e.gid) await this.reloadTimeline();
		if (e.type === 'edited' || e.type === 'deleted') await this.reloadLast();
	}

	private setTyping(gid: string, from: string, on: boolean): void {
		const key = gid + from;
		clearTimeout(this.timers.get(key));
		this.timers.delete(key);
		const now = this.typing[gid] ?? [];
		const next = on ? [...new Set([...now, from])] : now.filter((a) => a !== from);
		if (next.length !== now.length || on) this.typing = { ...this.typing, [gid]: next };
		if (on) this.timers.set(key, setTimeout(() => this.setTyping(gid, from, false), TYPING_EXPIRE_MS));
	}

	/** After leaving or declining: wait until the leave copies are out, then forget the group. */
	tidy(gid: string, tries = 40): void {
		setTimeout(async () => {
			if (this.engine.pendingCount() > 0 && tries > 0) return this.tidy(gid, tries - 1);
			await this.engine.deleteLocal(gid);
			this.records = this.engine.list();
			this.clearUnread(gid);
			await this.reloadLast();
		}, 500);
	}

	// ── Wiring for the relay (Messenger calls these) ────────────────────────────────────────

	async handle(from: string, plain: Plain, ts: number): Promise<void> {
		await this.ready;
		await this.engine.handle(from, plain, ts);
	}
	handleLive(from: string, plain: Plain): void {
		this.engine.handleLive(from, plain);
	}
	async sent(wid: string): Promise<boolean> {
		if (!this.engine.owns(wid)) return false;
		await this.engine.onSent(wid);
		if (this.open) await this.reloadTimeline();
		return true;
	}
	async applySync(m: GroupSync): Promise<void> {
		await this.ready;
		await this.engine.applySync(m);
	}
	async snapshot(): Promise<GroupSync[]> {
		await this.ready;
		return this.engine.snapshot();
	}
	resend(): void {
		this.engine.resendPending();
	}
}
