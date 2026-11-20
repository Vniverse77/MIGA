// Mobile (Android first). Files come from inside the package.
// Mobile-only features go here: push wake-ups, share sheet, QR scanning for addresses and link codes,
// and the native transports from the censorship-resistance plan (DNS and low-volume UDP).
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import {
	PUBLIC_ORIGIN,
	PUBLIC_RELAY,
	type BackgroundControl,
	type LinkPreviewFetcher,
	type Notifier,
	type NotifyPermission,
	type Platform
} from './types';
import { browserDownload } from './download';
import { webNotifier } from './webnotify';

type Native = {
	setChrome(c: string, l: boolean): void;
	setBottom(c: string): void;
	setCanGoBack(can: boolean): void;
	saveFile?(name: string, base64: string, mime: string): void;
	notifyPermission?(): string;
	requestNotifyPermission?(): void;
	notify?(tag: string, title: string, body: string): void;
	cancel?(tag: string): void;
	getBackground?(): boolean;
	setBackground?(on: boolean): void;
	batteryExemption?(): void;
	convertImage?(base64: string, maxEdge: number): string;
};
// MainActivity.kt registers this object; it is absent in a plain browser.
const native = () => (window as unknown as { MigaNative?: Native }).MigaNative;

let saving: { resolve: (r: 'saved' | 'cancelled') => void; reject: (e: Error) => void } | null = null;
// MainActivity.kt answers here after the system "create document" screen closed: 'saved', 'cancelled' or 'error'.
function answerSave(result: string): void {
	const waiting = saving;
	saving = null;
	if (result === 'saved' || result === 'cancelled') waiting?.resolve(result);
	else waiting?.reject(new Error('save failed'));
}

function saveFile(name: string, data: Uint8Array, mime: string): Promise<'saved' | 'cancelled'> {
	const n = native();
	if (!n?.saveFile) return browserDownload(name, data, mime);
	let binary = '';
	for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
	(window as unknown as { __migaSaved?: (result: string) => void }).__migaSaved = answerSave;
	return new Promise((resolve, reject) => {
		saving = { resolve, reject };
		n.saveFile!(name, btoa(binary), mime);
	});
}

// Notifications go through the native shell (MainActivity.kt): the Notification API does not work in an Android
// web view. The page still decides when to notify, so privacy settings and mute apply unchanged. A tap comes back
// through window.__migaTap(tag) and runs the click handler of the latest notification with that tag.
const taps = new Map<string, () => void>();
let asking: ((p: NotifyPermission) => void) | null = null;
if (typeof window !== 'undefined') {
	const w = window as unknown as { __migaTap?: (tag: string) => void; __migaPerm?: (p: string) => void };
	w.__migaTap = (tag) => {
		const run = taps.get(tag);
		taps.delete(tag);
		run?.();
	};
	w.__migaPerm = (p) => {
		const done = asking;
		asking = null;
		done?.(p === 'granted' ? 'granted' : 'denied');
	};
}

const nativeNotifier: Notifier = {
	async permission() {
		const n = native();
		if (!n?.notifyPermission) return webNotifier.permission();
		const p = n.notifyPermission();
		return p === 'granted' || p === 'default' ? p : 'denied';
	},
	request() {
		const n = native();
		if (!n?.requestNotifyPermission) return webNotifier.request();
		return new Promise((resolve) => {
			asking = resolve;
			n.requestNotifyPermission!();
		});
	},
	show(n) {
		const shell = native();
		if (!shell?.notify) return webNotifier.show(n);
		taps.set(n.tag, n.onClick);
		shell.notify(n.tag, n.title, n.body);
	},
	close(tag) {
		taps.delete(tag);
		const shell = native();
		if (shell?.cancel) shell.cancel(tag);
		else webNotifier.close(tag);
	}
};

// A foreground service keeps the connection alive while the app is in the background (docs/NOTIFICATIONS.md).
const background: BackgroundControl = {
	kind: 'service',
	async state() {
		const n = native();
		return { available: !!n?.setBackground, on: !!n?.getBackground?.() };
	},
	async set(on) {
		native()?.setBackground?.(on);
	},
	async batteryExemption() {
		native()?.batteryExemption?.();
	}
};

// Link previews: two commands of the Rust shell (src-tauri/src/preview.rs), called through the Tauri bridge.
type Bridge = { invoke(cmd: string, args?: unknown): Promise<unknown> };
const bridge = (): Bridge | undefined => (window as unknown as { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__;
const linkPreview: LinkPreviewFetcher | undefined =
	typeof window !== 'undefined' && bridge()
		? {
				page: (url) => bridge()!.invoke('fetch_preview', { url }) as Promise<{ url: string; html: string }>,
				async image(url) {
					const b64 = (await bridge()!.invoke('fetch_preview_image', { url })) as string;
					return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
				}
			}
		: undefined;

export const platform: Platform = {
	background,
	linkPreview,
	target: 'mobile',
	label: 'beta',
	notifier: nativeNotifier,
	packaged: true,
	relayUrl: () => PUBLIC_RELAY,
	publicOrigin: () => PUBLIC_ORIGIN,
	openExternal: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
	setupWindow: () => {},
	convertImage: async (bytes, maxEdge) => {
		const n = native();
		if (!n?.convertImage) return null;
		let binary = '';
		for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		await new Promise((r) => setTimeout(r, 0)); // let the page paint first: the call below blocks the script
		const out = n.convertImage(btoa(binary), maxEdge);
		if (!out) return null;
		return Uint8Array.from(atob(out), (c) => c.charCodeAt(0));
	},
	clipboard: { writeText: (text) => writeText(text), readText: async () => (await readText().catch(() => '')) || '' },
	saveFile,
	// The native shell does the tick when it can (MainActivity.kt), the Vibration API is the fallback.
	haptic: () => {
		const n = (window as unknown as { MigaNative?: { haptic?(): void } }).MigaNative;
		if (n?.haptic) n.haptic();
		else void navigator.vibrate?.(12);
	},
	appHistory: true,
	setBottom: (color) => native()?.setBottom(color),
	setCanGoBack: (can) => native()?.setCanGoBack(can),
	setChrome: (color, light) => {
		native()?.setChrome(color, light);
	}
};
