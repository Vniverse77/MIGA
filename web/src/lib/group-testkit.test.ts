// Test kit for groups: clients with a real GroupEngine and real encryption, wired through a loopback "relay"
// that behaves like the real one where it matters (one copy per relay id, `sent` per copy, ephemeral frames
// only to online clients). Used by group-engine.test.ts.
import { decrypt, newIdentity, type Identity, type Plain } from './crypto.ts';
import { GroupEngine, type GroupEvent } from './group-engine.ts';
import { MemoryGroupStore } from './group-store.ts';
import type { GroupSync } from './groups.ts';

export type Wire = { from: string; to: string; wid: string; body: string; eph: boolean };

export class Client {
	id: Identity = newIdentity();
	store = new MemoryGroupStore();
	engine: GroupEngine;
	events: GroupEvent[] = [];
	syncOut: GroupSync[] = [];
	contacts = new Map<string, { request?: boolean; unverified?: boolean }>();
	blocked = new Set<string>();
	strict = false;
	online = true;
	/** Everything this client handed to the relay: [to, wid]. */
	sentLog: { to: string; wid: string }[] = [];
	liveLog: string[] = [];

	constructor(public net: Net, public name: string, id?: Identity) {
		if (id) this.id = id;
		this.engine = new GroupEngine({
			me: this.id,
			store: this.store,
			transport: {
				send: (to, wid, body) => {
					if (!this.online) return false;
					this.sentLog.push({ to, wid });
					net.queue.push({ from: this.id.address, to, wid, body, eph: false });
					return true;
				},
				sendLive: (to, body) => {
					if (!this.online) return false;
					this.liveLog.push(to);
					net.queue.push({ from: this.id.address, to, wid: '', body, eph: true });
					return true;
				},
				syncAll: (m) => this.syncOut.push(structuredClone(m))
			},
			contactOf: (a) => this.contacts.get(a),
			isBlocked: (a) => this.blocked.has(a),
			strict: () => this.strict,
			ownName: () => this.name
		});
		this.engine.onEvent = (e) => this.events.push(e);
		net.clients.set(this.id.address, this);
	}
	get address() {
		return this.id.address;
	}
	/** Makes `other` a known contact (so an invite from it is not a request). */
	know(...others: Client[]) {
		for (const o of others) this.contacts.set(o.address, {});
	}
	messages(gid: string) {
		return this.engine.messages(gid);
	}
}

export class Net {
	clients = new Map<string, Client>();
	queue: Wire[] = [];
	/** Relay semantics: a (recipient, relay id) pair is stored once. */
	private seen = new Set<string>();
	delivered: Wire[] = [];
	/** Test hook: addresses whose queued copies are held back (an offline recipient). */
	held = new Map<string, Wire[]>();
	offline = new Set<string>();

	client(name: string): Client {
		return new Client(this, name);
	}

	async pump(): Promise<void> {
		for (let guard = 0; this.queue.length && guard < 10_000; guard++) {
			const w = this.queue.shift()!;
			const from = this.clients.get(w.from)!;
			if (!w.eph) {
				const key = `${w.to}:${w.wid}`;
				const fresh = !this.seen.has(key);
				this.seen.add(key);
				if (from.online) await from.engine.onSent(w.wid);
				if (!fresh) continue;
			}
			if (this.offline.has(w.to)) {
				if (!w.eph) (this.held.get(w.to) ?? this.held.set(w.to, []).get(w.to)!).push(w);
				continue; // ephemeral frames are never queued
			}
			await this.deliver(w);
		}
	}

	private async deliver(w: Wire): Promise<void> {
		const to = this.clients.get(w.to);
		if (!to) return;
		this.delivered.push(w);
		const plain = decrypt(to.id, w.from, w.body) as Plain | null;
		if (!plain) return;
		if (w.eph) return to.engine.handleLive(w.from, plain);
		if (plain.group || plain.g) await to.engine.handle(w.from, plain, Date.now());
	}

	async goOnline(address: string): Promise<void> {
		this.offline.delete(address);
		for (const w of this.held.get(address) ?? []) await this.deliver(w);
		this.held.delete(address);
		await this.pump();
	}
}
