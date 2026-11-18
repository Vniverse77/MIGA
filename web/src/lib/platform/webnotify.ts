// Notifications through the browser's Notification API. Used by the web build, and by the other
// builds when they run outside their native shell.
import type { Notifier, NotifyPermission } from './types';

const open = new Map<string, Notification>();

function supported(): boolean {
	return typeof Notification !== 'undefined';
}

function current(): NotifyPermission {
	return supported() ? Notification.permission : 'unsupported';
}

export const webNotifier: Notifier = {
	permission: async () => current(),
	async request() {
		if (!supported()) return 'unsupported';
		try {
			return await Notification.requestPermission();
		} catch {
			return current();
		}
	},
	show({ tag, title, body, onClick }) {
		if (current() !== 'granted') return;
		try {
			// `renotify` makes a replaced notification alert again; it is not in every TS lib version.
			const options: NotificationOptions & { renotify?: boolean } = { tag, body, renotify: true };
			const n = new Notification(title, options);
			n.onclick = () => {
				n.close();
				onClick();
			};
			n.onclose = () => {
				if (open.get(tag) === n) open.delete(tag);
			};
			open.set(tag, n);
		} catch {
			// Some mobile browsers only allow notifications through a service worker; stay silent.
		}
	},
	close(tag) {
		open.get(tag)?.close();
		open.delete(tag);
	}
};
