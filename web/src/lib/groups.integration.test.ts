// Groups against the real Go relay: five protocol-level clients (no browser, no UI), real WebSockets,
// the real blob store and the real linked-device sync envelope. Run: deno test --no-check --allow-all src/lib/groups.integration.test.ts
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1';
import { decryptFile, encryptFile, type Att } from './attach.ts';
import { decrypt, newIdentity, type Identity } from './crypto.ts';
import { GroupEngine, type GroupEvent } from './group-engine.ts';
import { MemoryGroupStore } from './group-store.ts';
import type { GroupSync } from './groups.ts';
import { powDay, solveSync } from './pow.ts';
import { RelayClient } from './relay.ts';
import { Harness, sleep } from './relay-harness.test.ts';

// devices.ts reads the build target through the platform module.
(globalThis as Record<string, unknown>).__MIGA_TARGET__ = 'web';
const { open, seal, syncKey } = await import('./devices.ts');

const opts = { sanitizeOps: false, sanitizeResources: false } as const;

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
	const t0 = performance.now();
	while (!(await cond())) {
		if (performance.now() - t0 > ms) throw new Error('timeout: ' + what);
		await sleep(20);
	}
}

/** One device of a person: the account connection (group traffic) and a device connection (sync). */
class Node {
	engine: GroupEngine;
	store = new MemoryGroupStore();
	events: GroupEvent[] = [];
	contacts = new Set<string>();
	account: RelayClient;
	devConn?: RelayClient;
	siblings: string[] = [];
	got: string[] = [];

	constructor(h: Harness, public name: string, public id: Identity, public dev: Identity = newIdentity()) {
		this.engine = new GroupEngine({
			me: id,
			store: this.store,
			transport: {
				send: (to, wid, body) => this.account.send(to, wid, body),
				sendLive: (to, body) => this.account.sendLive(to, body),
				syncAll: (m: GroupSync) => {
					for (const s of this.siblings) this.devConn?.send(s, 's' + Math.random().toString(16).slice(2, 18), seal(syncKey(id), m, dev.address + s));
				}
			},
			contactOf: (a) => (this.contacts.has(a) ? {} : undefined),
			isBlocked: () => false,
			strict: () => false,
			ownName: () => name
		});
		this.engine.onEvent = (e) => this.events.push(e);
		this.account = new RelayClient(h.url, id, {
			onStatus: () => {},
			onReady: () => this.engine.resendPending(),
			onMessage: (m) => {
				const plain = decrypt(id, m.from, m.body);
				if (plain && (plain.group || plain.g)) void this.engine.handle(m.from, plain, m.ts);
				return true;
			},
			onLive: (f) => {
				const plain = decrypt(id, f.from, f.body);
				if (plain) this.engine.handleLive(f.from, plain);
			},
			onSent: (wid) => void this.engine.onSent(wid),
			onError: () => {}
		});
	}

	async start(): Promise<void> {
		await this.engine.init();
		this.account.connect();
		await until(() => this.account.isReady, this.name + ' ready');
	}

	/** Connect the device address too (needed for sync) and listen for sibling sync messages. */
	async startSync(siblings: string[]): Promise<void> {
		this.siblings = siblings;
		this.devConn = new RelayClient(this.url!, this.dev, {
			onStatus: () => {},
			onReady: () => {},
			onMessage: (m) => {
				const msg = open<GroupSync>(syncKey(this.id), m.body, m.from + this.dev.address);
				if (msg) void this.engine.applySync(msg);
				return true;
			},
			onSent: () => {},
			onError: () => {}
		});
		this.devConn.connect();
		await until(() => this.devConn!.isReady, 'device ready');
	}
	url?: string;
	close() {
		this.account.close();
		this.devConn?.close();
	}
	get address() {
		return this.id.address;
	}
	texts = async (gid: string) => (await this.engine.messages(gid)).map((m) => m.text);
	count = (type: string) => this.events.filter((e) => e.type === type).length;
}

Deno.test({
	name: 'groups end to end on the real relay: create, invite, accept, fan-out, attachment once, remove, ban, typing, linked device',
	...opts,
	async fn() {
		const h = new Harness();
		await h.init();
		const nodes: Node[] = [];
		const mk = (name: string, id = newIdentity(), dev?: Identity) => {
			const n = new Node(h, name, id, dev);
			n.url = h.url;
			nodes.push(n);
			return n;
		};
		try {
			const [A, B, C, D, E] = ['Test Alpha', 'Test Bravo', 'Test Charlie', 'Test Delta', 'Test Echo'].map((n) => mk(n));
			// Bravo has a second device (same account key, own device key).
			const B2 = mk('Test Bravo 2', B.id);
			for (const n of [A, B, C, D, E, B2]) await n.start();
			await B.startSync([B2.dev.address]);
			await B2.startSync([B.dev.address]);
			for (const x of [B, C, D]) x.contacts.add(A.address);

			// create with three invitees; Echo is a stranger and gets a proof of work
			const rec = await A.engine.create('Test Group', [B.address, C.address, D.address]);
			const gid = rec.state.id;
			await until(() => [B, C, D].every((x) => x.engine.get(gid)?.status === 'invited'), 'invites arrive');
			await until(() => B2.engine.get(gid)?.status === 'invited', 'second device sees the invite (relay push to both devices)');
			for (const x of [B, C, D]) await x.engine.accept(gid);
			await until(() => A.engine.get(gid)!.accepted.length === 4, 'accepts arrive');
			assertEquals(A.engine.get(gid)!.accepted.length, 4);
			await until(() => B2.engine.get(gid)?.status === 'active', 'accept synced to the linked device');

			// invite the stranger with proof of work: a request until accepted, "checked"
			await A.engine.invite(gid, E.address, solveSync(A.address, E.address, powDay()));
			await until(() => E.engine.get(gid)?.status === 'invited', 'stranger invite arrives');
			assertEquals(E.engine.get(gid)!.request, true);
			assertEquals(E.engine.get(gid)!.unverified, undefined);
			await until(() => [B, C, D].every((x) => x.engine.get(gid)?.state.members.length === 5), 'epoch 2 reached everyone');
			await E.engine.accept(gid);
			await until(() => A.engine.get(gid)!.accepted.includes(E.address), 'echo accepted');
			// a sixth member is refused
			let code = '';
			try {
				await A.engine.invite(gid, newIdentity().address);
			} catch (e) {
				code = (e as { code: string }).code;
			}
			assertEquals(code, 'full');

			// message fan-out: everyone gets it once, including the linked device
			const m1 = await C.engine.sendMessage(gid, { text: 'hello from Charlie' });
			await until(async () => (await Promise.all([A, B, D, E, B2].map((x) => x.texts(gid)))).every((t) => t.includes('hello from Charlie')), 'fan-out');
			await sleep(300);
			for (const x of [A, B, D, E, B2]) assertEquals((await x.texts(gid)).filter((t) => t === 'hello from Charlie').length, 1, x.name + ' got it exactly once');
			await until(async () => Object.values((await C.engine.messages(gid))[0].to!).every((s) => s === 'sent'), 'four sent ticks');
			assertEquals(Object.keys((await C.engine.messages(gid))[0].to!).length, 4);
			assertEquals(C.engine.pendingCount(), 0);
			void m1;

			// attachment: uploaded ONCE, the same blob id in every envelope, every member can fetch and open it
			const photo = Uint8Array.from({ length: 150_000 }, (_, i) => (i * 31 + 7) & 255);
			const enc = encryptFile(photo);
			const put = await fetch(`http://127.0.0.1:${h.proxyPort}/blob`, { method: 'PUT', body: enc.cipher as BodyInit });
			assertEquals(put.status, 201);
			const up = await put.json();
			const att: Att = { blob: up.id, key: enc.key, nonce: enc.nonce, hash: enc.hash, mime: 'image/webp', size: photo.length, w: 100, h: 100, thumb: '', del: up.del };
			await B.engine.sendMessage(gid, { text: 'a photo', att });
			await until(async () => (await Promise.all([A, C, D, E].map((x) => x.texts(gid)))).every((t) => t.includes('a photo')), 'attachment message');
			for (const x of [A, C, D, E]) {
				const got = (await x.engine.messages(gid)).find((m) => m.text === 'a photo')!;
				assertEquals(got.att!.blob, up.id);
				assertEquals(got.att!.del, undefined, 'no delete token for recipients');
				const res = await fetch(`http://127.0.0.1:${h.proxyPort}/blob/${got.att!.blob}`);
				const plain = decryptFile(new Uint8Array(await res.arrayBuffer()), got.att!);
				assertEquals(plain, photo);
			}

			// typing: online members see it, as an ephemeral frame
			C.engine.sendTyping(gid, true);
			await until(() => A.count('typing') > 0 && D.count('typing') > 0, 'typing frames');

			// remove Delta: the next messages never reach Delta
			await A.engine.remove(gid, D.address);
			await until(() => D.engine.get(gid)?.status === 'removed', 'delta learns it was removed');
			await until(() => [B, C, E].every((x) => x.engine.get(gid)?.state.members.length === 4), 'others learn it');
			const dBefore = (await D.texts(gid)).length;
			await A.engine.sendMessage(gid, { text: 'after removal' });
			await until(async () => (await Promise.all([B, C, E].map((x) => x.texts(gid)))).every((t) => t.includes('after removal')), 'remaining members get it');
			await sleep(400);
			assertEquals((await D.texts(gid)).length, dBefore, 'removed member received nothing');
			assertFalse((await D.texts(gid)).includes('after removal'));
			assertEquals(A.engine.recipients(gid).includes(D.address), false);

			// ban Echo: cannot be re-invited, its accept and its messages are ignored
			await A.engine.ban(gid, E.address);
			await until(() => E.engine.get(gid)?.status === 'banned', 'echo banned');
			let c2 = '';
			try {
				await A.engine.invite(gid, E.address);
			} catch (e) {
				c2 = (e as { code: string }).code;
			}
			assertEquals(c2, 'banned');
			const before = (await B.texts(gid)).length;
			await E.engine.sendMessage(gid, { text: 'let me back' }).catch(() => {});
			await sleep(400);
			assertEquals((await B.texts(gid)).length, before);
			assertEquals(A.engine.get(gid)!.state.members.includes(E.address), false);

			// the linked device ended up with the same group and the same messages as Bravo
			await until(async () => JSON.stringify((await B2.texts(gid)).sort()) === JSON.stringify((await B.texts(gid)).sort()), 'linked device has the same messages');
			assertEquals(B2.engine.get(gid)!.state.epoch, B.engine.get(gid)!.state.epoch);
			assert((await B2.texts(gid)).includes('a photo'));
			console.log(`  groups e2e: ${(await B.texts(gid)).length} messages on Bravo, epoch ${A.engine.get(gid)!.state.epoch}`);
		} finally {
			for (const n of nodes) n.close();
			await h.dispose();
		}
	}
});
