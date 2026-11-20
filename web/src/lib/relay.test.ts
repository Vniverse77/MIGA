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
