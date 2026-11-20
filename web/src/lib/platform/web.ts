// Web: the page is served by a relay and talks to that same relay.
// Web-only pieces live here and in src/service-worker/ (offline copy, update notice).
import type { Platform } from './types';
import { browserDownload } from './download';
import { webNotifier } from './webnotify';

export const platform: Platform = {
	target: 'web',
	label: '',
	notifier: webNotifier,
	shortcuts: { newChat: 'Alt+N', find: false },
	packaged: false,
	relayUrl: () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
	publicOrigin: () => location.origin,
	openExternal: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
	setupWindow: () => {},
	saveFile: browserDownload,
	// Chrome on Android only; other browsers have no vibration API and ignore the call.
	haptic: () => void navigator.vibrate?.(12)
};
