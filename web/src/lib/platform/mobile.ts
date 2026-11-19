// Mobile (Android first). Files come from inside the package.
// Mobile-only features go here: push wake-ups, share sheet, QR scanning for addresses and link codes,
// and the native transports from the censorship-resistance plan (DNS and low-volume UDP).
import { PUBLIC_ORIGIN, PUBLIC_RELAY, type Platform } from './types';
import { webNotifier } from './webnotify';

type Native = { setChrome(c: string, l: boolean): void; setBottom(c: string): void; setCanGoBack(can: boolean): void };
// MainActivity.kt registers this object; it is absent in a plain browser.
const native = () => (window as unknown as { MigaNative?: Native }).MigaNative;

export const platform: Platform = {
	target: 'mobile',
	label: 'beta',
	notifier: webNotifier,
	packaged: true,
	relayUrl: () => PUBLIC_RELAY,
	publicOrigin: () => PUBLIC_ORIGIN,
	openExternal: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
	setupWindow: () => {},
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
