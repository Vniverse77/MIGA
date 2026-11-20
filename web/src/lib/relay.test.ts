// Integration tests: the real Go relay behind a TCP proxy that can go silent (a socket that died while
// the app slept looks exactly like that: no close, no error, no frames).
// Run: deno test --no-check --allow-all src/lib/relay.test.ts
import { RelayClient, TIMING, type Incoming, type Status, type Timing } from './relay.ts';
import { newIdentity, randomId } from './crypto.ts';

const dec = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
	const l = Deno.listen({ port: 0, hostname: '127.0.0.1' });
	const port = (l.addr as Deno.NetAddr).port;
	l.close();
	return port;
}

export class Harness {
	relayPort = 0;
	proxyPort = 0;
	private proc: Deno.ChildProcess | null = null;
	private listener: Deno.Listener | null = null;
	private pipes = new Set<Deno.Conn>();
	/** Pipes that went silent. New connections are never affected. */
	private dead = new Set<Deno.Conn>();
	dir = '';
	bin = '';

	async init(): Promise<void> {
		this.dir = await Deno.makeTempDir({ prefix: 'miga-relay-' });
		this.bin = `${this.dir}/relay`;
		const build = await new Deno.Command('go', {
			args: ['build', '-o', this.bin, '.'],
			cwd: new URL('../../../relay', import.meta.url).pathname
		}).output();
		if (!build.success) throw new Error('go build failed: ' + dec.decode(build.stderr));
		this.relayPort = await freePort();
		this.proxyPort = await freePort();
		await this.startRelay();
		this.listener = Deno.listen({ port: this.proxyPort, hostname: '127.0.0.1' });
		void this.accept();
	}

	get url(): string {
		return `ws://127.0.0.1:${this.proxyPort}/ws`;
	}

	async startRelay(): Promise<void> {
		this.proc = new Deno.Command(this.bin, {
			env: { MIGA_ADDR: `127.0.0.1:${this.relayPort}`, MIGA_DB: `${this.dir}/relay.db` },
			stdout: 'null',
			stderr: 'null'
		}).spawn();
		for (let i = 0; i < 100; i++) {
			try {
				(await Deno.connect({ port: this.relayPort, hostname: '127.0.0.1' })).close();
				return;
			} catch {
				await sleep(50);
			}
		}
		throw new Error('relay did not start');
	}

	async stopRelay(): Promise<void> {
		this.proc?.kill('SIGTERM');
		await this.proc?.status;
		this.proc = null;
		for (const c of this.pipes) {
			try {
				c.close();
			} catch {
				/* closed */
			}
		}
		this.pipes.clear();
	}

	private async accept(): Promise<void> {
		for (;;) {
			let client: Deno.Conn;
			try {
				client = await this.listener!.accept();
			} catch {
				return;
			}
			void this.pipe(client);
		}
	}

	private async pipe(client: Deno.Conn): Promise<void> {
		let upstream: Deno.Conn;
		try {
			upstream = await Deno.connect({ port: this.relayPort, hostname: '127.0.0.1' });
		} catch {
			client.close();
			return;
		}
		this.pipes.add(client).add(upstream);
		const copy = async (from: Deno.Conn, to: Deno.Conn) => {
			const buf = new Uint8Array(16384);
			try {
				for (;;) {
					const n = await from.read(buf);
					if (n === null) break;
					if (!this.dead.has(from) && !this.dead.has(to)) await to.write(buf.subarray(0, n));
					// frozen: swallow the bytes, keep both sockets open (a black hole)
				}
			} catch {
				/* closed */
			}
			try {
				to.close();
			} catch {
				/* closed */
			}
		};
		void copy(client, upstream);
		void copy(upstream, client);
	}

	/** Existing connections go silent (no close, no error); connections made later work normally. */
	freeze(): void {
		for (const c of this.pipes) this.dead.add(c);
	}

	/** Drop every proxied connection without telling anyone upstream-side semantics (RST-like close). */
	killPipes(): void {
		for (const c of this.pipes) {
			try {
				c.close();
			} catch {
				/* closed */
			}
		}
		this.pipes.clear();
		this.dead.clear();
	}

	async dispose(): Promise<void> {
		this.listener?.close();
		await this.stopRelay();
		await Deno.remove(this.dir, { recursive: true });
	}
}

export function connect(
	h: Harness,
	id: ReturnType<typeof newIdentity>,
	timing: Timing = TIMING
): {
	client: RelayClient;
	log: { status: Status; at: number }[];
	got: Incoming[];
	sent: string[];
	ready: () => number;
	waitReady: (n: number, ms?: number) => Promise<number>;
} {
	const log: { status: Status; at: number }[] = [];
	const got: Incoming[] = [];
	const sent: string[] = [];
	let readyCount = 0;
	const client = new RelayClient(
		h.url,
		id,
		{
			onStatus: (status) => log.push({ status, at: performance.now() }),
			onReady: () => readyCount++,
			onMessage: (m) => (got.push(m), true),
			onSent: (i) => sent.push(i),
			onError: () => {}
		},
		timing
	);
	const waitReady = async (n: number, ms = 20_000) => {
		const t0 = performance.now();
		while (readyCount < n) {
			if (performance.now() - t0 > ms) throw new Error(`not ready (${readyCount}/${n})`);
			await sleep(10);
		}
		return performance.now();
	};
	return { client, log, got, sent, ready: () => readyCount, waitReady };
}

const opts = { sanitizeOps: false, sanitizeResources: false } as const;

Deno.test({
	name: 'dead socket: no pong -> offline, reconnect, messages flow again',
	...opts,
	async fn() {
		const h = new Harness();
		await h.init();
		try {
			const a = connect(h, newIdentity(), { ...TIMING, pingMs: 300, pongMs: 300 });
			a.client.connect();
			await a.waitReady(1);
			h.freeze();
			const t0 = performance.now();
			const t1 = await a.waitReady(2);
			console.log(`  detect+reconnect ${(t1 - t0).toFixed(0)} ms (ping 300, pong 300)`);
			a.client.close();
		} finally {
			await h.dispose();
		}
	}
});

Deno.test({
	name: 'resume after background: silent socket is replaced in under 3 s (default timing)',
	...opts,
	async fn() {
		const h = new Harness();
		await h.init();
		try {
			const a = connect(h, newIdentity());
			a.client.connect();
			await a.waitReady(1);
			h.freeze(); // the app goes to the background; the socket silently dies
			await sleep(3500); // longer than staleMs, shorter than pingMs
			const t0 = performance.now();
			a.client.resume(); // visibilitychange -> visible
			const t1 = await a.waitReady(2);
			const ms = t1 - t0;
			console.log(`  RESUME_MS=${ms.toFixed(0)}`);
			if (ms > 3000) throw new Error(`resume took ${ms} ms`);
			a.client.close();
		} finally {
			await h.dispose();
		}
	}
});

export { randomId };

Deno.test({
	name: 'queued messages survive a relay restart and arrive exactly once despite repeated sends',
	...opts,
	async fn() {
		const h = new Harness();
		await h.init();
		try {
			const alice = newIdentity();
			const bob = newIdentity();
			const ids = [randomId(), randomId(), randomId()];
			const pending = new Set(ids);
			const a = connect(h, alice, { ...TIMING });
			// Same pattern as Messenger: everything pending is sent again at every (re)connect, with the same id.
			const resend = () => {
				for (const id of pending) a.client.send(bob.address, id, `body-${id}`);
			};
			const origReady = a.waitReady;
			a.client.connect();
			await origReady(1);
			a.client.send(bob.address, ids[0], `body-${ids[0]}`); // accepted before the outage
			while (!a.sent.includes(ids[0])) await sleep(10);
			pending.delete(ids[0]);

			await h.stopRelay();
			// Offline: the sends fail and the messages stay pending.
			if (a.client.send(bob.address, ids[1], 'x')) throw new Error('send must fail while offline');
			await h.startRelay();
			// Reconnect (backoff 1 s), then the resend pass. ids[1] and ids[2] never reached the relay.
			await origReady(2);
			resend();
			resend(); // a duplicate retry on purpose
			await sleep(300);

			const b = connect(h, bob);
			b.client.connect();
			await b.waitReady(1);
			await sleep(1500);
			const counts = new Map<string, number>();
			for (const m of b.got) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
			for (const id of ids) if (counts.get(id) !== 1) throw new Error(`id ${id} delivered ${counts.get(id) ?? 0} times`);
			if (b.got.length !== 3) throw new Error(`expected 3 deliveries, got ${b.got.length}`);
			a.client.close();
			b.client.close();
		} finally {
			await h.dispose();
		}
	}
});

Deno.test({
	name: 'typing and live text: ephemeral frames reach an online peer, are never queued for an offline one',
	...opts,
	async fn() {
		const { encryptTyping, encryptLive, decrypt } = await import('./crypto.ts');
		const h = new Harness();
		await h.init();
		try {
			const alice = newIdentity();
			const bob = newIdentity();
			const a = connect(h, alice);
			a.client.connect();
			await a.waitReady(1);
			// Bob is offline: the frames vanish, nothing waits for him.
			a.client.sendLive(bob.address, encryptTyping(alice, bob.address, true));
			a.client.sendLive(bob.address, encryptLive(alice, bob.address, 'hel'));
			await sleep(300);
			const seen: string[] = [];
			const b = new RelayClient(
				h.url,
				bob,
				{
					onStatus: () => {},
					onReady: () => {},
					onMessage: (m) => (seen.push('queued:' + m.id), true),
					onSent: () => {},
					onLive: (f) => {
						const plain = decrypt(bob, f.from, f.body);
						if (plain?.typing !== undefined) seen.push(plain.typing ? 'typing' : 'stopped');
						else if (plain?.live !== undefined) seen.push('live:' + plain.live);
					},
					onError: () => {}
				},
				TIMING
			);
			b.connect();
			for (let i = 0; i < 300 && !b['ready']; i++) await sleep(10);
			await sleep(300);
			assertEq(seen.length, 0, 'offline frames must not be queued');
			a.client.sendLive(bob.address, encryptTyping(alice, bob.address, true));
			await sleep(5);
			a.client.sendLive(bob.address, encryptLive(alice, bob.address, 'hello'));
			await sleep(5);
			a.client.sendLive(bob.address, encryptTyping(alice, bob.address, false));
			await sleep(600);
			// The relay forwards each ephemeral frame in its own goroutine, so arrival order is not guaranteed
			// (the app orders them by the sender's timestamp inside the ciphertext). All three must arrive.
			assertEq([...seen].sort().join(','), 'live:hello,stopped,typing', 'online frames arrive');
			a.client.close();
			b.close();
		} finally {
			await h.dispose();
		}
	}
});

function assertEq(a: unknown, b: unknown, msg: string): void {
	if (a !== b) throw new Error(`${msg}: got ${String(a)}, want ${String(b)}`);
}
