// Mobile (Android first). Files come from inside the package.
// Mobile-only features go here: push wake-ups, share sheet, QR scanning for addresses and link codes,
// and the native transports from the censorship-resistance plan (DNS and low-volume UDP).
import { PUBLIC_ORIGIN, PUBLIC_RELAY, type Platform } from './types';
import { browserDownload } from './download';
import { webNotifier } from './webnotify';

type Native = {
	setChrome(c: string, l: boolean): void;
	setBottom(c: string): void;
	setCanGoBack(can: boolean): void;
	saveFile?(name: string, base64: string, mime: string): void;
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

export const platform: Platform = {
	target: 'mobile',
	label: 'beta',
	notifier: webNotifier,
	packaged: true,
	relayUrl: () => PUBLIC_RELAY,
	publicOrigin: () => PUBLIC_ORIGIN,
	openExternal: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
	setupWindow: () => {},
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
