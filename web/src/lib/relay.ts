// WebSocket client for the MIGA relay. See docs/PROTOCOL.md.
// This is one possible transport: it only moves opaque encrypted bodies.
import { signAuth, type Identity } from './crypto';

export type Status = 'connecting' | 'online' | 'offline';
export type Incoming = { from: string; id: string; body: string; ts: number };

export type RelayEvents = {
	onStatus(status: Status): void;
	/** Called after authentication; resend anything still pending. */
	onReady(): void;
	/** Return true once the message is safely stored locally (it is then acknowledged). */
	onMessage(message: Incoming): boolean;
	onSent(id: string): void;
	onError(code: string, id?: string): void;
};

const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

export class RelayClient {
	private ws: WebSocket | null = null;
	private ready = false;
	private closed = false;
	private backoff = 1000;
	private pingTimer: ReturnType<typeof setInterval> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private url: string,
		private identity: Identity,
		private events: RelayEvents
	) {}

	connect(): void {
		if (this.closed) return;
		this.events.onStatus('connecting');
		const ws = new WebSocket(this.url);
		this.ws = ws;

		ws.onmessage = (event) => {
			let frame: Record<string, unknown>;
			try {
				frame = JSON.parse(String(event.data));
			} catch {
				return;
			}
			this.handle(ws, frame);
		};
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.ready = false;
			clearInterval(this.pingTimer);
			this.events.onStatus('offline');
			if (this.closed) return;
			this.retryTimer = setTimeout(() => this.connect(), this.backoff);
			this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
		};
		ws.onerror = () => ws.close();
	}

	close(): void {
		this.closed = true;
		clearTimeout(this.retryTimer);
		clearInterval(this.pingTimer);
		this.ws?.close();
	}

	/** Returns false when offline; the caller keeps the message pending. */
	send(to: string, id: string, body: string): boolean {
		if (!this.ready || !this.ws) return false;
		this.ws.send(JSON.stringify({ t: 'send', to, id, body }));
		return true;
	}

	/**
	 * Asks the relay to drop a message of ours that is still waiting for `to`. Fire and forget:
	 * a relay that does not know the frame answers `bad_frame`, which the caller ignores.
	 */
	unsend(to: string, id: string): void {
		if (this.ready && this.ws) this.ws.send(JSON.stringify({ t: 'unsend', to, id }));
	}

	private handle(ws: WebSocket, frame: Record<string, unknown>): void {
		switch (frame.t) {
			case 'challenge':
				ws.send(
					JSON.stringify({
						t: 'auth',
						pub: this.identity.address,
						sig: signAuth(this.identity, String(frame.nonce))
					})
				);
				break;
			case 'ready':
				this.ready = true;
				this.backoff = 1000;
				this.pingTimer = setInterval(() => ws.send('{"t":"ping"}'), PING_MS);
				this.events.onStatus('online');
				this.events.onReady();
				break;
			case 'msg': {
				const message: Incoming = {
					from: String(frame.from),
					id: String(frame.id),
					body: String(frame.body),
					ts: Number(frame.ts)
				};
				if (this.events.onMessage(message)) {
					ws.send(JSON.stringify({ t: 'ack', from: message.from, id: message.id }));
				}
				break;
			}
			case 'sent':
				this.events.onSent(String(frame.id));
				break;
			case 'error':
				this.events.onError(
					String(frame.err),
					typeof frame.id === 'string' ? frame.id : undefined
				);
				break;
		}
	}
}
