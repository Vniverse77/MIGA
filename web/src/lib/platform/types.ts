// One interface, three implementations. Each build contains exactly one of them
// (see index.ts), so code written for one environment is never shipped to another.
export type Target = 'web' | 'desktop' | 'mobile';

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported';

/** Local notifications while the app is running. Nothing here talks to any server. */
export interface Notifier {
	/** Current permission, without asking. */
	permission(): Promise<NotifyPermission>;
	/** Asks the user. Call it only from a click on a visible control, never at start. */
	request(): Promise<NotifyPermission>;
	/** Shows a notification; the same `tag` replaces the earlier one. `onClick` runs if the platform supports clicks. */
	show(n: { tag: string; title: string; body: string; onClick: () => void }): void;
	/** Removes the notification with this tag, if the platform allows it. */
	close(tag: string): void;
}

export interface Platform {
	/** Native notifications on desktop, the Notification API elsewhere. */
	readonly notifier: Notifier;
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
