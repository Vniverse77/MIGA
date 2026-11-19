// Keyboard layer for builds with a physical keyboard (desktop app, web on a mouse-driven device).
// What each platform offers is declared in platform/{desktop,web}.ts (`shortcuts`); touch builds
// declare none, so nothing here runs there. The page wires one handler and a few actions.
import { platform } from '../platform';

/** Which shortcut layers are open. Esc closes the top one first. */
export const layers = $state({ switcher: false, help: false });

/** Shortcuts apply when the platform declares them and the main input is a mouse, not a finger. */
export function shortcutsOn(): boolean {
	return !!platform.shortcuts && typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches;
}

/** Closes the top shortcut layer; true if one was open. */
export function closeTopLayer(): boolean {
	if (layers.help) return (layers.help = false), true;
	if (layers.switcher) return (layers.switcher = false), true;
	return false;
}

export type ShortcutActions = {
	/** The app is ready for commands (an identity exists). */
	ready(): boolean;
	newChat(): void;
	settings(): void;
	/** Moves to the previous (-1) or next (1) chat in list order. */
	step(delta: -1 | 1): void;
	find(): void;
	/** Focuses the composer if a chat is open; true if it did. */
	focusComposer(): boolean;
};

const FIELD = 'input, textarea, select, [contenteditable="true"]';

/** One keydown handler for the whole window. IME composition and other dialogs are left alone. */
export function onShortcutKey(e: KeyboardEvent, a: ShortcutActions): void {
	const profile = platform.shortcuts;
	if (!profile || !shortcutsOn() || e.isComposing || e.keyCode === 229 || e.defaultPrevented || !a.ready()) return;
	// Another modal (confirm dialog, attachment viewer) owns the keyboard.
	if (document.querySelector('dialog[open], [aria-modal="true"]:not([data-kb])')) return;
	const key = e.key.toLowerCase();
	const mod = e.ctrlKey || e.metaKey;
	const use = (fn: () => void) => (e.preventDefault(), fn());

	if (mod && !e.altKey) {
		if (!e.shiftKey) {
			if (key === 'k') return use(() => ((layers.help = false), (layers.switcher = !layers.switcher)));
			if (key === ',') return use(() => ((layers.switcher = layers.help = false), a.settings()));
			if (key === '/') return use(() => ((layers.switcher = false), (layers.help = !layers.help)));
			if (key === 'f' && profile.find) return use(() => ((layers.switcher = layers.help = false), a.find()));
			if (key === 'n' && profile.newChat === 'Ctrl+N') return use(() => ((layers.switcher = layers.help = false), a.newChat()));
		} else if (key === '?' || key === '/') return use(() => ((layers.switcher = false), (layers.help = !layers.help)));
	}
	if (e.altKey && !mod && !e.shiftKey) {
		if (key === 'n' && profile.newChat === 'Alt+N') return use(() => ((layers.switcher = layers.help = false), a.newChat()));
		if (key === 'arrowup' || key === 'arrowdown') return use(() => a.step(key === 'arrowup' ? -1 : 1));
	}
	// Typing anywhere outside a field goes to the composer.
	if (!mod && !e.altKey && e.key.length === 1 && !layers.switcher && !layers.help) {
		const target = e.target instanceof Element ? e.target : null;
		if (target?.closest(FIELD + ', button, a, [role="button"], summary')) return;
		if (a.focusComposer()) return; // the browser then types the key into the focused composer
	}
}
