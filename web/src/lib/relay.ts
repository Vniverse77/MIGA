// WebSocket client for the MIGA relay. See docs/PROTOCOL.md.
// This is one possible transport: it only moves opaque encrypted bodies.
import { signAuth, type Identity } from './crypto';

export type Status = 'connecting' | 'online' | 'offline';
export type Incoming = { from: string; id: string; body: string; ts: number };
export type LiveIncoming = { from: string; body: string };

export type RelayEvents = {
	onStatus(status: Status): void;
	/** Called after authentication; resend anything still pending. */
	onReady(): void;
	/** Return true once the message is safely stored locally (it is then acknowledged). */
	onMessage(message: Incoming): boolean;
	onSent(id: string): void;
	/** Ephemeral frame (live typing). Never acknowledged, never stored. */
	onLive?(frame: LiveIncoming): void;
	onError(code: string, id?: string): void;
};

/** Timing of the dead-socket detection. Tests shorten these. */
export type Timing = {
	/** Ping while connected and quiet. */
	pingMs: number;
	/** No frame at all this long after a ping: the socket is dead. */
	pongMs: number;
	/** After the app returns (visible, online, pageshow) a socket quiet for this long gets probed. */
	staleMs: number;
	/** Pong deadline of that probe; short, because the person is looking at the screen. */
	probeMs: number;
	/** The handshake (challenge, auth, ready) must finish in this time. */
	handshakeMs: number;
	maxBackoffMs: number;
};
export const TIMING: Timing = {
	pingMs: 20_000,
	pongMs: 8_000,
	staleMs: 3_000,
	probeMs: 1_500,
	handshakeMs: 10_000,
	maxBackoffMs: 30_000
};

export class RelayClient {
	private ws: WebSocket | null = null;
	private ready = false;
	private closed = false;
	private backoff = 1000;
	private pingTimer: ReturnType<typeof setInterval> | undefined;
	private deadTimer: ReturnType<typeof setTimeout> | undefined;
	private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
	private lastFrameAt = 0;
	private connectedAt = 0;
	private listening = false;
	/** Set when an old relay refused an ephemeral frame (it does not know `eph`). */
	private ephUnsupported = false;
	private lastLiveAt = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private url: string,
		private identity: Identity,
		private events: RelayEvents,
		private timing: Timing = TIMING
	) {}

	connect(): void {
		if (this.closed) return;
		this.listen();
		clearTimeout(this.retryTimer);
		this.events.onStatus('connecting');
		const ws = new WebSocket(this.url);
		this.ws = ws;
		this.connectedAt = this.lastFrameAt = Date.now();
		// A socket that never finishes the handshake (dead network) would stay "connecting" for minutes.
		this.handshakeTimer = setTimeout(() => this.drop(ws), this.timing.handshakeMs);

		ws.onmessage = (event) => {
			let frame: Record<string, unknown>;
			try {
				frame = JSON.parse(String(event.data));
			} catch {
				return;
			}
			this.lastFrameAt = Date.now();
			clearTimeout(this.deadTimer);
			this.handle(ws, frame);
		};
		ws.onclose = () => this.drop(ws);
		ws.onerror = () => this.drop(ws);
	}

	/**
	 * The socket is gone or must be treated as gone: detach it, close it and schedule a reconnect.
	 * The close handshake of a dead socket can take minutes, so nothing here waits for `onclose`.
	 */
	private drop(ws: WebSocket, immediate = false): void {
		if (this.ws !== ws) return;
		this.ws = null;
		ws.onmessage = ws.onclose = ws.onerror = null;
		try {
			ws.close();
		} catch {
			/* already closed */
		}
		this.ready = false;
		clearInterval(this.pingTimer);
		clearTimeout(this.deadTimer);
		clearTimeout(this.handshakeTimer);
		this.events.onStatus('offline');
		if (this.closed) return;
		if (immediate) {
			this.backoff = 1000;
			this.connect();
			return;
		}
		this.retryTimer = setTimeout(() => this.connect(), this.backoff);
		this.backoff = Math.min(this.backoff * 2, this.timing.maxBackoffMs);
	}

	/** Ping now; no frame within `deadlineMs` and the socket is dropped and reopened at once. */
	private probe(ws: WebSocket, deadlineMs: number): void {
		try {
			ws.send('{"t":"ping"}');
		} catch {
			return this.drop(ws, true);
		}
		clearTimeout(this.deadTimer);
		this.deadTimer = setTimeout(() => this.drop(ws, true), deadlineMs);
	}

	/**
	 * The app came back (visible, online, pageshow, native resume). A socket that was quiet for a while
	 * is probed with a short deadline; a pending reconnect is not waited for.
	 */
	resume(): void {
		if (this.closed) return;
		const ws = this.ws;
		if (!ws) {
			this.backoff = 1000;
			this.connect();
		} else if (!this.ready) {
			// Still handshaking: give up on a slow attempt and try again.
			if (Date.now() - this.connectedAt > this.timing.staleMs) this.drop(ws, true);
		} else if (Date.now() - this.lastFrameAt > this.timing.staleMs) {
			this.probe(ws, this.timing.probeMs);
		}
	}

	private wake = () => this.resume();
	private onVisible = () => {
		if (document.visibilityState === 'visible') this.resume();
	};

	private listen(): void {
		if (this.listening || typeof window === 'undefined') return;
		this.listening = true;
		document.addEventListener('visibilitychange', this.onVisible);
		window.addEventListener('online', this.wake);
		window.addEventListener('pageshow', this.wake);
		// A native shell can dispatch this event when the app returns from the background.
		window.addEventListener('miga:resume', this.wake);
	}

	private unlisten(): void {
		if (!this.listening) return;
		this.listening = false;
		document.removeEventListener('visibilitychange', this.onVisible);
		window.removeEventListener('online', this.wake);
		window.removeEventListener('pageshow', this.wake);
		window.removeEventListener('miga:resume', this.wake);
	}

	close(): void {
		this.closed = true;
		clearTimeout(this.retryTimer);
		clearInterval(this.pingTimer);
		clearTimeout(this.deadTimer);
		clearTimeout(this.handshakeTimer);
		this.unlisten();
		this.ws?.close();
	}

	/** True when authenticated and able to send. */
	get isReady(): boolean {
		return this.ready && !!this.ws;
	}

	/** Returns false when offline; the caller keeps the message pending. */
	send(to: string, id: string, body: string): boolean {
		if (!this.ready || !this.ws) return false;
		this.ws.send(JSON.stringify({ t: 'send', to, id, body }));
		return true;
	}

	/**
	 * Ephemeral frame: delivered only to devices of `to` that are online right now, never queued.
	 * Fire and forget; false when offline or when the relay is too old to know `eph`.
	 */
	sendLive(to: string, body: string): boolean {
		if (!this.ready || !this.ws || this.ephUnsupported) return false;
		this.lastLiveAt = Date.now();
		this.ws.send(JSON.stringify({ t: 'send', to, eph: true, body }));
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
				this.ephUnsupported = false;
				this.backoff = 1000;
				clearTimeout(this.handshakeTimer);
				this.pingTimer = setInterval(() => this.probe(ws, this.timing.pongMs), this.timing.pingMs);
				this.events.onStatus('online');
				this.events.onReady();
				break;
			case 'msg': {
				if (frame.eph === true) {
					this.events.onLive?.({ from: String(frame.from), body: String(frame.body) });
					break;
				}
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
				// A relay without `eph` support rejects the frame (no id); stop sending live text.
				if (frame.err === 'bad_frame' && typeof frame.id !== 'string' && Date.now() - this.lastLiveAt < 1500) {
					this.ephUnsupported = true;
				}
				this.events.onError(
					String(frame.err),
					typeof frame.id === 'string' ? frame.id : undefined
				);
				break;
		}
	}
}
