// One interface, three implementations. Each build contains exactly one of them
// (see index.ts), so code written for one environment is never shipped to another.
export type Target = 'web' | 'desktop' | 'mobile';

export interface Platform {
	readonly target: Target;
	/** Shown next to the version, empty on the web. */
	readonly label: string;
	/** The relay this build talks to. */
	relayUrl(): string;
	/** Opens a link outside the app (system browser on desktop and mobile). */
	openExternal(url: string): void;
	/** True when the app's files come from inside a package, not from a server. */
	readonly packaged: boolean;
}

/** The public relay, used by builds that are not served by a relay themselves. */
export const PUBLIC_RELAY = 'wss://miga.vniverse77.com/ws';
