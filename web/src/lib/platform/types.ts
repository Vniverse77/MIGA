// One interface, three implementations. Each build contains exactly one of them
// (see index.ts), so code written for one environment is never shipped to another.
export type Target = 'web' | 'desktop' | 'mobile';

export interface Platform {
	readonly target: Target;
	/** Shown next to the version, empty on the web. */
	readonly label: string;
	/** The relay this build talks to. */
	relayUrl(): string;
	/** Web origin used in links meant to be opened elsewhere (QR codes, invites). */
	publicOrigin(): string;
	/** Opens a link outside the app (system browser on desktop and mobile). */
	openExternal(url: string): void;
	/** True when the app's files come from inside a package, not from a server. */
	readonly packaged: boolean;
	/** Called once when the app mounts: lets a packaged build drop page behaviours (menus, zoom, drag). */
	setupWindow(): void;
}

/** The public relay, used by builds that are not served by a relay themselves. */
export const PUBLIC_RELAY = 'wss://miga.vniverse77.com/ws';

/** Where packaged builds point links, since they are not served from a web origin themselves. */
export const PUBLIC_ORIGIN = 'https://miga.vniverse77.com';
