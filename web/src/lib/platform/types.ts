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

/** Keyboard shortcuts of a build with a physical keyboard (desktop app, web). Absent on touch builds. */
export interface ShortcutProfile {
	/** The key that starts a new chat; browsers keep Ctrl+N for a new window, so the web uses Alt+N. */
	readonly newChat: 'Ctrl+N' | 'Alt+N';
	/** Ctrl+F opens search inside the chat. A browser keeps its own find bar. */
	readonly find: boolean;
}

/** Keeping MIGA connected while its window is closed or the app is in the background. */
export interface BackgroundControl {
	/** `tray`: the desktop window hides to the tray icon. `service`: an Android foreground service. */
	readonly kind: 'tray' | 'service';
	/** Current state; `available` is false when this system cannot do it (desktop without a status area). */
	state(): Promise<{ available: boolean; on: boolean }>;
	set(on: boolean): Promise<void>;
	/** Android only: opens the system prompt that exempts MIGA from battery optimisation. */
	batteryExemption?(): Promise<void>;
}

/** The system clipboard through the shell, for builds whose WebView has no reliable web clipboard API. */
export interface NativeClipboard {
	writeText(text: string): Promise<void>;
	/** Plain text on the clipboard, or ''. */
	readText(): Promise<string>;
	/** An image on the clipboard as PNG bytes; absent where the system cannot read images. */
	readImage?(): Promise<Uint8Array | null>;
}

/** Native page fetching for link previews (desktop and Android only; the browser cannot, and should not). */
export interface LinkPreviewFetcher {
	/** The first 512 KB of the page and its address after redirects. Rejects for private addresses, other schemes, timeouts. */
	page(url: string): Promise<{ url: string; html: string }>;
	/** An image of at most 300 KB. */
	image(url: string): Promise<Uint8Array>;
}

export interface Platform {
	/** Native clipboard of the desktop and Android shells; absent in the browser. */
	readonly clipboard?: NativeClipboard;
	/** Absent in the browser build: sending a link there never contacts the site. */
	readonly linkPreview?: LinkPreviewFetcher;
	/** Background connection setting; absent in the browser, where a closed tab cannot keep a connection. */
	readonly background?: BackgroundControl;
	/** Desktop: the unread total (muted chats left out) for the tray icon. */
	setUnread?(count: number): void;
	/** Keyboard shortcuts; undefined on builds that have no keyboard layer (mobile). */
	readonly shortcuts?: ShortcutProfile;
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
	/** Android only: tells the native shell the page colour and whether the theme is light, so the status and navigation bars match. */
	setChrome?(color: string, light: boolean): void;
	/** Android only: the colour behind the bottom navigation bar for the current screen. */
	setBottom?(color: string): void;
	/** Android only: true while a layer is open that the page closes on Back; false at the list, where the system handles Back. */
	setCanGoBack?(can: boolean): void;
	/** A light tick when a long-press starts a menu. Absent where the device has no way to do it. */
	haptic?(): void;
	/**
	 * Hands a file to the person: a save dialog on desktop, the system "create document" screen on Android,
	 * a download in a browser. Resolves `cancelled` when they closed the dialog, rejects when writing failed.
	 * Nothing is uploaded anywhere.
	 */
	saveFile(name: string, data: Uint8Array, mime: string): Promise<'saved' | 'cancelled'>;
	/** Android only: in-app screens take part in the system history, so the Back gesture steps back inside the app. */
	readonly appHistory?: boolean;
}

/** The public relay, used by builds that are not served by a relay themselves. */
export const PUBLIC_RELAY = 'wss://miga.vniverse77.com/ws';

/** Where packaged builds point links, since they are not served from a web origin themselves. */
export const PUBLIC_ORIGIN = 'https://miga.vniverse77.com';
