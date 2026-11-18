// Theme choice: dark (default, as on vniverse77.com), light, or follow the system.
// The inline script in app.html applies the saved choice before first paint; this module keeps it in step.
export type Theme = 'dark' | 'light' | 'system';

const KEY_THEME = 'miga.theme';
const isTheme = (value: unknown): value is Theme =>
	value === 'dark' || value === 'light' || value === 'system';

let current = $state<Theme>('dark');

function apply(): void {
	const light =
		current === 'light' ||
		(current === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
	const root = document.documentElement;
	if (light) root.dataset.theme = 'light';
	else delete root.dataset.theme;
	document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f0f4ff' : '#070b14');
}

/** Reads the saved choice and follows system changes while "system" is selected. Browser only. */
export function initTheme(): void {
	let saved: string | null = null;
	try {
		saved = localStorage.getItem(KEY_THEME);
	} catch {
		// Storage can be blocked; dark applies.
	}
	if (isTheme(saved)) current = saved;
	apply();
	matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
		if (current === 'system') apply();
	});
}

export function getTheme(): Theme {
	return current;
}

export function setTheme(theme: Theme): void {
	current = theme;
	apply();
	try {
		localStorage.setItem(KEY_THEME, theme);
	} catch {
		// Not saved; the choice still holds for this visit.
	}
}
