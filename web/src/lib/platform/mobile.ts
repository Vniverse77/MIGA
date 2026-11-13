// Mobile (Android first). Files come from inside the package.
// Mobile-only features go here: push wake-ups, share sheet, QR scanning for addresses and link codes,
// and the native transports from the censorship-resistance plan (DNS and low-volume UDP).
import { PUBLIC_ORIGIN, PUBLIC_RELAY, type Platform } from './types';

export const platform: Platform = {
	target: 'mobile',
	label: 'mobile',
	packaged: true,
	relayUrl: () => PUBLIC_RELAY,
	publicOrigin: () => PUBLIC_ORIGIN,
	openExternal: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
	setupWindow: () => {}
};
