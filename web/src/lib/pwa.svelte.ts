// Web only: the browser's install prompt, whether the page already runs as an installed app, and the unread badge
// (tab title is done in Messenger; here the favicon dot and the app icon badge). Nothing leaves the page.
type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: InstallEvent | null = null;

export const pwa = $state({
	/** The browser offered an install prompt and it can be shown now. */
	canInstall: false,
	/** Already running as an installed app (no install row, no website links). */
	standalone: false,
	/** iPhone/iPad Safari has no prompt: show the manual hint instead. */
	ios: false
});

if (typeof window !== 'undefined') {
	const standalone = (): boolean =>
		matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
	pwa.standalone = standalone();
	pwa.ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
	matchMedia('(display-mode: standalone)').addEventListener('change', () => (pwa.standalone = standalone()));
	addEventListener('beforeinstallprompt', (e) => {
		e.preventDefault();
		deferred = e as InstallEvent;
		pwa.canInstall = true;
	});
	addEventListener('appinstalled', () => {
		deferred = null;
		pwa.canInstall = false;
		pwa.standalone = true;
	});
}

/** Shows the browser's install dialog. Resolves true when the user accepted. */
export async function promptInstall(): Promise<boolean> {
	if (!deferred) return false;
	const e = deferred;
	deferred = null;
	pwa.canInstall = false;
	await e.prompt();
	return (await e.userChoice).outcome === 'accepted';
}

let faviconSrc: HTMLImageElement | null = null;
let faviconLink: HTMLLinkElement | null = null;

/** Unread count in the app icon (where supported) and a dot on the tab icon. */
export function setUnreadBadge(n: number): void {
	try {
		const nav = navigator as unknown as { setAppBadge?(n?: number): Promise<void>; clearAppBadge?(): Promise<void> };
		void (n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => {});
	} catch {
		// Badging is optional.
	}
	if (n <= 0) {
		faviconLink?.remove();
		faviconLink = null;
		return;
	}
	const draw = (img: HTMLImageElement): void => {
		const c = document.createElement('canvas');
		c.width = c.height = 64;
		const g = c.getContext('2d');
		if (!g) return;
		g.drawImage(img, 0, 0, 64, 64);
		g.fillStyle = '#e5484d';
		g.strokeStyle = '#ffffff';
		g.lineWidth = 3;
		g.beginPath();
		g.arc(48, 16, 12, 0, Math.PI * 2);
		g.fill();
		g.stroke();
		if (!faviconLink) {
			faviconLink = document.createElement('link');
			faviconLink.rel = 'icon';
			faviconLink.type = 'image/png';
			document.head.append(faviconLink);
		}
		faviconLink.href = c.toDataURL('image/png');
	};
	if (faviconSrc?.complete) return draw(faviconSrc);
	faviconSrc = new Image();
	faviconSrc.onload = () => faviconSrc && draw(faviconSrc);
	faviconSrc.src = '/android-chrome-192x192.png';
}
