// Web: the page is served by a relay and talks to that same relay.
// Web-only pieces live here and in src/service-worker/ (offline copy, update notice).
import type { Platform } from './types';

export const platform: Platform = {
	target: 'web',
	label: '',
	packaged: false,
	relayUrl: () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
	openExternal: (url) => void window.open(url, '_blank', 'noopener,noreferrer')
};
