// Desktop (Tauri window on Linux, later Windows and macOS). Files come from inside the package.
// Desktop-only features go here: tray icon, start at login, native notifications, global shortcuts.
import {
	isPermissionGranted,
	requestPermission,
	sendNotification
} from '@tauri-apps/plugin-notification';
import { readImage, readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import {
	PUBLIC_ORIGIN,
	PUBLIC_RELAY,
	type BackgroundControl,
	type Notifier,
	type NotifyPermission,
	type Platform
} from './types';
import { browserDownload } from './download';
import { webNotifier } from './webnotify';

/** True inside the Tauri shell; false when this build is opened in an ordinary browser. */
const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// The four small commands of the shell (src-tauri/src/lib.rs). Called through the core bridge directly,
// which keeps the page free of extra packages.
type TrayState = { tray: boolean; keep: boolean; notify: boolean };
function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke(c: string, a?: unknown): Promise<T> } })
		.__TAURI_INTERNALS__;
	if (!internals) return Promise.reject(new Error('not in the app'));
	return internals.invoke(cmd, args);
}

const background: BackgroundControl = {
	kind: 'tray',
	async state() {
		try {
			const s = await call<TrayState>('tray_state');
			return { available: s.tray, on: s.tray && s.keep };
		} catch {
			return { available: false, on: false };
		}
	},
	async set(on) {
		await call('set_keep_in_tray', { keep: on });
	}
};

/**
 * Native notifications through the official Tauri plugin (libnotify on Linux). The desktop plugin
 * cannot report clicks or replace a shown notification, so `onClick` and `tag` are not used here;
 * the app only notifies while its window is hidden or unfocused, so a stale entry is rare.
 */
const nativeNotifier: Notifier = {
	async permission(): Promise<NotifyPermission> {
		try {
			return (await isPermissionGranted()) ? 'granted' : 'default';
		} catch {
			return 'unsupported';
		}
	},
	async request(): Promise<NotifyPermission> {
		try {
			return await requestPermission();
		} catch {
			return 'unsupported';
		}
	},
	show({ title, body }) {
		// "Disable notifications" in the tray menu is kept by the shell; ask it each time (it is a cheap local call).
		call<TrayState>('tray_state')
			.catch(() => ({ notify: true }))
			.then((s) => {
				if (s.notify) sendNotification({ title, body });
			})
			.catch(() => {
				// A failed notification must never break message handling.
			});
	},
	close() {}
};

/**
 * Native save dialog (official dialog plugin), then one write to the path the person chose (fs plugin).
 * The dialog adds that single path to the fs scope; the app has no other file access.
 */
async function saveFile(name: string, data: Uint8Array, mime: string): Promise<'saved' | 'cancelled'> {
	if (!inTauri()) return browserDownload(name, data, mime);
	const { save } = await import('@tauri-apps/plugin-dialog');
	const { writeFile } = await import('@tauri-apps/plugin-fs');
	const extension = name.includes('.') ? name.split('.').pop()! : '';
	const path = await save({
		defaultPath: name,
		filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined
	});
	if (!path) return 'cancelled';
	await writeFile(path, data);
	return 'saved';
}

export const platform: Platform = {
	target: 'desktop',
	label: 'desktop',
	notifier: {
		permission: () => (inTauri() ? nativeNotifier : webNotifier).permission(),
		request: () => (inTauri() ? nativeNotifier : webNotifier).request(),
		show: (n) => (inTauri() ? nativeNotifier : webNotifier).show(n),
		close: (tag) => (inTauri() ? nativeNotifier : webNotifier).close(tag)
	},
	background: inTauri() ? background : undefined,
	setUnread: (count) => {
		if (inTauri()) void call('set_unread', { count }).catch(() => {});
	},
	shortcuts: { newChat: 'Ctrl+N', find: true },
	packaged: true,
	relayUrl: () => PUBLIC_RELAY,
	publicOrigin: () => PUBLIC_ORIGIN,
	openExternal: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
	setupWindow,
	saveFile,
	clipboard: {
		writeText: (text) => writeText(text),
		readText: async () => (await readText().catch(() => '')) || '',
		async readImage() {
			const img = await readImage().catch(() => null);
			if (!img) return null;
			const { width, height } = await img.size();
			const rgba = await img.rgba();
			const canvas = new OffscreenCanvas(width, height);
			const ctx = canvas.getContext('2d');
			if (!ctx) return null;
			ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
			const blob = await canvas.convertToBlob({ type: 'image/png' });
			return new Uint8Array(await blob.arrayBuffer());
		}
	}
};

const TEXT_FIELD = 'input, textarea, [contenteditable]';

function inside(event: Event, selector: string): boolean {
	return event.target instanceof Element && event.target.closest(selector) !== null;
}

/** Makes the window behave like an app: no image dragging, browser menu, reload or page zoom. */
function setupWindow(): void {
	document.documentElement.classList.add('desktop');
	document.addEventListener('dragstart', (event) => {
		if (!inside(event, 'input, textarea')) event.preventDefault();
	});
	document.addEventListener('contextmenu', (event) => {
		if (!inside(event, TEXT_FIELD + ', .selectable')) event.preventDefault();
	});
	document.addEventListener('keydown', (event) => {
		const key = event.key.toLowerCase();
		const ctrl = event.ctrlKey || event.metaKey;
		const blocked =
			key === 'f5' ||
			(ctrl && ['r', 'p', 'u', '=', '+', '-', '_', '0'].includes(key));
		if (blocked) event.preventDefault();
	});
	document.addEventListener(
		'wheel',
		(event) => {
			if (event.ctrlKey) event.preventDefault();
		},
		{ passive: false }
	);
}
