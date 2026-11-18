// Local persistence. Everything stays in this browser; nothing here is sent anywhere.
import {
	bytesToHex,
	hexToBytes,
	identityFromSecret,
	isAddress,
	newIdentity,
	type Identity,
	type Reply
} from './crypto';
import { deleteDb, openDb, req, tx, type MessageRecord } from './db';

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
const KEY_BLOCKED = 'miga.blocked';

/** The most addresses one account may block. */
export const MAX_BLOCKED = 500;

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
export async function eraseAll(): Promise<void> {
	erased = true; // later saves become no-ops, so nothing is written back
	await writeQueue.catch(() => {});
	db?.close();
	db = null;
	await deleteDb();
	for (const key of [
		KEY_IDENTITY,
		KEY_CONTACTS,
		KEY_CHATS,
		KEY_PROFILE,
		KEY_DEVICE,
		KEY_DEVICES,
		KEY_LINK,
		KEY_BLOCKED
	]) {
		localStorage.removeItem(key);
	}
}

// ── Contacts, blocked list and chats (IndexedDB, with a localStorage fallback) ────────────

export type AppData = { contacts: Contact[]; chats: Chats; blocked: string[] };

let db: IDBDatabase | null = null;
let erased = false;
/** Writes run one after another so a later save never overtakes an earlier one. */
let writeQueue: Promise<unknown> = Promise.resolve();
/** JSON of what is already stored, to write only what changed. */
let storedMessages = new Map<string, string>();
let storedContacts = new Map<string, string>();
let storedBlocked = '';

function queue(job: () => Promise<unknown>): void {
	writeQueue = writeQueue.then(job).catch(() => {});
}

function cleanBlocked(stored: unknown): string[] {
	if (!Array.isArray(stored)) return [];
	return [...new Set(stored.filter((a): a is string => typeof a === 'string' && isAddress(a)))].slice(
		0,
		MAX_BLOCKED
	);
}

function legacyData(): AppData {
	return {
		contacts: readJson<Contact[]>(KEY_CONTACTS, []),
		chats: readJson<Chats>(KEY_CHATS, {}),
		blocked: cleanBlocked(readJson<unknown>(KEY_BLOCKED, []))
	};
}

function messageRecords(chats: Chats): Map<string, MessageRecord> {
	const out = new Map<string, MessageRecord>();
	for (const [chat, list] of Object.entries(chats)) {
		list.forEach((m, i) => out.set(JSON.stringify([chat, m.id]), { ...m, chat, i }));
	}
	return out;
}

/**
 * Opens the database, moves a v0.5.0 profile over once, and returns everything stored.
 * Migration: only when the `migrated` marker is missing and old localStorage data exists. Data and
 * marker are written in ONE transaction; the old keys are removed only after it committed, so an
 * interrupted run just repeats (puts are idempotent) and never loses data.
 */
export async function loadData(): Promise<AppData> {
	try {
		db = await openDb();
		// Ask the browser not to evict our storage; failure is fine.
		navigator.storage?.persist?.().catch(() => {});
		const d = db;
		const done = await tx(d, ['meta'], 'readonly', (t) => req(t.objectStore('meta').get('migrated')));
		const hasLegacy = [KEY_CONTACTS, KEY_CHATS, KEY_BLOCKED].some((k) => localStorage.getItem(k) !== null);
		if (!done && hasLegacy) {
			const old = legacyData();
			await tx(d, ['messages', 'contacts', 'meta'], 'readwrite', (t) => {
				for (const r of messageRecords(old.chats).values()) t.objectStore('messages').put(r);
				old.contacts.forEach((c, i) => t.objectStore('contacts').put({ ...c, i }));
				t.objectStore('meta').put(old.blocked, 'blocked');
				t.objectStore('meta').put(Date.now(), 'migrated');
			});
		}
		if (hasLegacy) {
			// Committed (or already migrated earlier): the old copies are no longer needed.
			for (const k of [KEY_CONTACTS, KEY_CHATS, KEY_BLOCKED]) localStorage.removeItem(k);
		}
		return await tx(d, ['messages', 'contacts', 'meta'], 'readonly', async (t) => {
			const msgs = await req(t.objectStore('messages').index('chat_i').getAll());
			const contactRows = (await req(t.objectStore('contacts').getAll())) as (Contact & { i: number })[];
			const blocked = cleanBlocked(await req(t.objectStore('meta').get('blocked')));
			const chats: Chats = {};
			storedMessages = new Map();
			for (const { chat, i, ...m } of msgs as MessageRecord[]) {
				(chats[chat] ??= []).push(m as unknown as Message);
				storedMessages.set(JSON.stringify([chat, m.id]), JSON.stringify({ ...m, chat, i }));
			}
			contactRows.sort((a, b) => a.i - b.i);
			storedContacts = new Map();
			const contacts = contactRows.map(({ i, ...c }) => {
				storedContacts.set(c.address, JSON.stringify({ ...c, i }));
				return c;
			});
			storedBlocked = JSON.stringify(blocked);
			void navigator.storage?.persist?.();
			return { contacts, chats, blocked };
		});
	} catch {
		// No usable IndexedDB (some private modes): keep working from localStorage as before.
		db = null;
		return legacyData();
	}
}

export function saveContacts(contacts: Contact[]): void {
	if (erased) return;
	if (!db) return void localStorage.setItem(KEY_CONTACTS, JSON.stringify(contacts));
	const next = new Map(contacts.map((c, i) => [c.address, JSON.stringify({ ...c, i })]));
	queue(() => {
		const puts = [...next].filter(([k, v]) => storedContacts.get(k) !== v);
		const dels = [...storedContacts.keys()].filter((k) => !next.has(k));
		if (!puts.length && !dels.length) return Promise.resolve();
		return tx(db!, ['contacts'], 'readwrite', (t) => {
			const s = t.objectStore('contacts');
			for (const [, v] of puts) s.put(JSON.parse(v));
			for (const k of dels) s.delete(k);
		}).then(() => (storedContacts = next));
	});
}

export function saveChats(chats: Chats): void {
	if (erased) return;
	if (!db) return void localStorage.setItem(KEY_CHATS, JSON.stringify(chats));
	const records = messageRecords(chats);
	const next = new Map([...records].map(([k, r]) => [k, JSON.stringify(r)]));
	queue(() => {
		const puts = [...next].filter(([k, v]) => storedMessages.get(k) !== v);
		const dels = [...storedMessages.keys()].filter((k) => !next.has(k));
		if (!puts.length && !dels.length) return Promise.resolve();
		return tx(db!, ['messages'], 'readwrite', (t) => {
			const s = t.objectStore('messages');
			for (const [k] of puts) s.put(records.get(k)!);
			for (const k of dels) s.delete(JSON.parse(k));
		}).then(() => (storedMessages = next));
	});
}

/** Addresses whose messages are dropped on arrival. A deleted contact stays blocked. */
export function saveBlocked(blocked: string[]): void {
	if (erased) return;
	if (!db) return void localStorage.setItem(KEY_BLOCKED, JSON.stringify(blocked));
	const json = JSON.stringify(blocked);
	queue(async () => {
		if (json === storedBlocked) return;
		await tx(db!, ['meta'], 'readwrite', (t) => void t.objectStore('meta').put(blocked, 'blocked'));
		storedBlocked = json;
	});
}

function readJson<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}
