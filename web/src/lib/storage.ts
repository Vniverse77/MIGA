// Local persistence. Everything stays in this browser; nothing here is sent anywhere.
import { bytesToHex, hexToBytes, identityFromSecret, newIdentity, type Identity } from './crypto';

export type Contact = { address: string; name: string };
export type Message = {
	id: string;
	mine: boolean;
	text: string;
	ts: number;
	state: 'pending' | 'sent' | 'failed' | 'received';
};
export type Chats = Record<string, Message[]>;

const KEY_IDENTITY = 'miga.identity';
const KEY_CONTACTS = 'miga.contacts';
const KEY_CHATS = 'miga.chats';

export function loadIdentity(): Identity {
	const stored = localStorage.getItem(KEY_IDENTITY);
	if (stored && /^[0-9a-f]{64}$/.test(stored)) return identityFromSecret(hexToBytes(stored));
	const identity = newIdentity();
	saveIdentity(identity);
	return identity;
}

export function saveIdentity(identity: Identity): void {
	localStorage.setItem(KEY_IDENTITY, bytesToHex(identity.secret));
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
