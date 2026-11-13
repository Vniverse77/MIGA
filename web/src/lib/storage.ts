// Local persistence. Everything stays in this browser; nothing here is sent anywhere.
import {
	bytesToHex,
	hexToBytes,
	identityFromSecret,
	newIdentity,
	type Identity,
	type Reply
} from './crypto';

/** `custom` marks a name the user typed; a name the contact shares never replaces it. */
export type Contact = { address: string; name: string; custom?: boolean };
/** Empty name means anonymous. `share` decides whether the name is sent to the people you write to. */
export type Profile = { name: string; share: boolean };
/** Another device of the same account. `address` is that device's own key, not the account's. */
export type Device = { address: string; label: string; added: number };
export type Message = {
	id: string;
	mine: boolean;
	text: string;
	ts: number;
	state: 'pending' | 'sent' | 'failed' | 'received';
	reply?: Reply;
};
export type Chats = Record<string, Message[]>;

const KEY_IDENTITY = 'miga.identity';
const KEY_CONTACTS = 'miga.contacts';
const KEY_CHATS = 'miga.chats';
const KEY_PROFILE = 'miga.profile';
const KEY_DEVICE = 'miga.device';
const KEY_DEVICES = 'miga.devices';
const KEY_LINK = 'miga.link';

/** Returns null on a first visit: the identity is created only when the user asks for it. */
export function loadIdentity(): Identity | null {
	const stored = localStorage.getItem(KEY_IDENTITY);
	if (stored && /^[0-9a-f]{64}$/.test(stored)) return identityFromSecret(hexToBytes(stored));
	return null;
}

export function createIdentity(): Identity {
	const identity = newIdentity();
	saveIdentity(identity);
	return identity;
}

export function loadProfile(): Profile {
	const stored = readJson<Partial<Profile>>(KEY_PROFILE, {});
	return {
		name: typeof stored.name === 'string' ? stored.name.slice(0, 40) : '',
		share: stored.share !== false
	};
}

export function saveProfile(profile: Profile): void {
	localStorage.setItem(KEY_PROFILE, JSON.stringify(profile));
}

export function saveIdentity(identity: Identity): void {
	localStorage.setItem(KEY_IDENTITY, bytesToHex(identity.secret));
}

/** This device's own key. It never leaves the device and is separate from the account key. */
export function loadDevice(): Identity {
	const stored = localStorage.getItem(KEY_DEVICE);
	if (stored && /^[0-9a-f]{64}$/.test(stored)) return identityFromSecret(hexToBytes(stored));
	const device = newIdentity();
	localStorage.setItem(KEY_DEVICE, bytesToHex(device.secret));
	return device;
}

export function loadDevices(): Device[] {
	return readJson<Device[]>(KEY_DEVICES, []);
}

export function saveDevices(devices: Device[]): void {
	localStorage.setItem(KEY_DEVICES, JSON.stringify(devices));
}

/**
 * Secret of the throwaway mailbox behind a link code that is still open. Remembered so the
 * bundle can be deleted from the relay even if the tab was closed while the code was shown.
 */
export function loadOpenLink(): string | null {
	const stored = localStorage.getItem(KEY_LINK);
	return stored && /^[0-9a-f]{64}$/.test(stored) ? stored : null;
}

export function saveOpenLink(mailboxSecret: string | null): void {
	if (mailboxSecret) localStorage.setItem(KEY_LINK, mailboxSecret);
	else localStorage.removeItem(KEY_LINK);
}

/** Removes the account from this browser. The language choice is not personal and stays. */
export function eraseAll(): void {
	for (const key of [
		KEY_IDENTITY,
		KEY_CONTACTS,
		KEY_CHATS,
		KEY_PROFILE,
		KEY_DEVICE,
		KEY_DEVICES,
		KEY_LINK
	]) {
		localStorage.removeItem(key);
	}
}

export function loadContacts(): Contact[] {
	return readJson<Contact[]>(KEY_CONTACTS, []);
}

export function saveContacts(contacts: Contact[]): void {
	localStorage.setItem(KEY_CONTACTS, JSON.stringify(contacts));
}

export function loadChats(): Chats {
	return readJson<Chats>(KEY_CHATS, {});
}

export function saveChats(chats: Chats): void {
	localStorage.setItem(KEY_CHATS, JSON.stringify(chats));
}

function readJson<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}
