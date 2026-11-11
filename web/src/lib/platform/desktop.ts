// Desktop (Tauri window on Linux, later Windows and macOS). Files come from inside the package.
// Desktop-only features go here: tray icon, start at login, native notifications, global shortcuts.
import { PUBLIC_RELAY, type Platform } from './types';

export const platform: Platform = {
	target: 'desktop',
	label: 'desktop',
	packaged: true,
	relayUrl: () => PUBLIC_RELAY,
	openExternal: (url) => void window.open(url, '_blank', 'noopener,noreferrer')
};
