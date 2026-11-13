// Desktop (Tauri window on Linux, later Windows and macOS). Files come from inside the package.
// Desktop-only features go here: tray icon, start at login, native notifications, global shortcuts.
import { PUBLIC_ORIGIN, PUBLIC_RELAY, type Platform } from './types';

export const platform: Platform = {
	target: 'desktop',
	label: 'desktop',
	packaged: true,
	relayUrl: () => PUBLIC_RELAY,
	publicOrigin: () => PUBLIC_ORIGIN,
	openExternal: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
	setupWindow
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
			(ctrl && ['r', 'p', 'u', 'f', '=', '+', '-', '_', '0'].includes(key));
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
