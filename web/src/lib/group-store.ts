// Storage for groups: the group records, their messages and the queue of copies still to be delivered.
// The engine only sees `GroupStore`, so tests run on `MemoryGroupStore` and the app on `IdbGroupStore`.
import { openDb, req, tx } from './db';
import type { GroupMessage, GroupRecord } from './groups';

/** One encrypted copy for one member that the relay has not confirmed yet. Control and content both use it. */
export type OutItem = {
	/** Relay id of this copy. */
	wid: string;
	to: string;
	gid: string;
	/** The message it belongs to (content only), so `sent` can tick the right recipient. */
	mid?: string;
	/** The plaintext object: `{group: ..}` or `{g: ..}`. Encrypted again on every retry (same relay id). */
	payload: { group: object } | { g: object };
	pow?: { v: number; d: number; n: number };
	ts: number;
};

export interface GroupStore {
	loadGroups(): Promise<GroupRecord[]>;
	putGroup(rec: GroupRecord): Promise<void>;
	deleteGroup(gid: string): Promise<void>;
	getMessage(gid: string, id: string): Promise<GroupMessage | undefined>;
	putMessage(m: GroupMessage): Promise<void>;
	listMessages(gid: string): Promise<GroupMessage[]>;
	deleteMessage(gid: string, id: string): Promise<void>;
	loadOut(): Promise<OutItem[]>;
	putOut(item: OutItem): Promise<void>;
	deleteOut(wid: string): Promise<void>;
}

export class MemoryGroupStore implements GroupStore {
	groups = new Map<string, GroupRecord>();
	messages = new Map<string, GroupMessage>();
	out = new Map<string, OutItem>();
	private k = (gid: string, id: string) => `${gid}/${id}`;
	// structuredClone: callers must not share objects with the store, as with IndexedDB.
	async loadGroups() {
		return [...this.groups.values()].map((g) => structuredClone(g));
	}
	async putGroup(rec: GroupRecord) {
		this.groups.set(rec.state.id, structuredClone(rec));
	}
	async deleteGroup(gid: string) {
		this.groups.delete(gid);
		for (const [k, m] of this.messages) if (m.gid === gid) this.messages.delete(k);
		for (const [k, o] of this.out) if (o.gid === gid) this.out.delete(k);
	}
	async getMessage(gid: string, id: string) {
		const m = this.messages.get(this.k(gid, id));
		return m ? structuredClone(m) : undefined;
	}
	async putMessage(m: GroupMessage) {
		this.messages.set(this.k(m.gid, m.id), structuredClone(m));
	}
	async listMessages(gid: string) {
		return [...this.messages.values()].filter((m) => m.gid === gid).sort((a, b) => a.ts - b.ts).map((m) => structuredClone(m));
	}
	async deleteMessage(gid: string, id: string) {
		this.messages.delete(this.k(gid, id));
	}
	async loadOut() {
		return [...this.out.values()].map((o) => structuredClone(o));
	}
	async putOut(item: OutItem) {
		this.out.set(item.wid, structuredClone(item));
	}
	async deleteOut(wid: string) {
		this.out.delete(wid);
	}
}

/** IndexedDB stores `groups` (key `gid`), `gmessages` (key [gid, id]) and `gout` (key `wid`); see db.ts. */
export class IdbGroupStore implements GroupStore {
	private dbp: Promise<IDBDatabase> | null = null;
	private db = () => (this.dbp ??= openDb());

	async loadGroups() {
		const db = await this.db();
		const rows = (await tx(db, ['groups'], 'readonly', (t) => req(t.objectStore('groups').getAll()))) as (GroupRecord & { gid: string })[];
		return rows.map(({ gid: _gid, ...rec }) => rec as GroupRecord);
	}
	async putGroup(rec: GroupRecord) {
		const db = await this.db();
		await tx(db, ['groups'], 'readwrite', (t) => void t.objectStore('groups').put({ ...rec, gid: rec.state.id }));
	}
	async deleteGroup(gid: string) {
		const db = await this.db();
		await tx(db, ['groups', 'gmessages', 'gout'], 'readwrite', async (t) => {
			t.objectStore('groups').delete(gid);
			t.objectStore('gmessages').delete(IDBKeyRange.bound([gid, ''], [gid, '￿']));
			const out = (await req(t.objectStore('gout').getAll())) as OutItem[];
			for (const o of out) if (o.gid === gid) t.objectStore('gout').delete(o.wid);
		});
	}
	async getMessage(gid: string, id: string) {
		const db = await this.db();
		return (await tx(db, ['gmessages'], 'readonly', (t) => req(t.objectStore('gmessages').get([gid, id])))) as GroupMessage | undefined;
	}
	async putMessage(m: GroupMessage) {
		const db = await this.db();
		await tx(db, ['gmessages'], 'readwrite', (t) => void t.objectStore('gmessages').put(m));
	}
	async listMessages(gid: string) {
		const db = await this.db();
		const rows = (await tx(db, ['gmessages'], 'readonly', (t) =>
			req(t.objectStore('gmessages').getAll(IDBKeyRange.bound([gid, ''], [gid, '￿'])))
		)) as GroupMessage[];
		return rows.sort((a, b) => a.ts - b.ts);
	}
	async deleteMessage(gid: string, id: string) {
		const db = await this.db();
		await tx(db, ['gmessages'], 'readwrite', (t) => void t.objectStore('gmessages').delete([gid, id]));
	}
	async loadOut() {
		const db = await this.db();
		return (await tx(db, ['gout'], 'readonly', (t) => req(t.objectStore('gout').getAll()))) as OutItem[];
	}
	async putOut(item: OutItem) {
		const db = await this.db();
		await tx(db, ['gout'], 'readwrite', (t) => void t.objectStore('gout').put(item));
	}
	async deleteOut(wid: string) {
		const db = await this.db();
		await tx(db, ['gout'], 'readwrite', (t) => void t.objectStore('gout').delete(wid));
	}
}
