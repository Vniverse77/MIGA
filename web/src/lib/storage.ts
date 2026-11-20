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
import type { Att } from './attach';
import { RECENT_EMOJI_KEY } from './emoji';
import { deleteDb, openDb, req, tx, type MessageRecord } from './db';
import { cleanHistoryJob, cleanTombs, pruneTombs, type HistoryJob, type Tomb } from './sync';

/** `custom` marks a name the user typed; a name the contact shares never replaces it. */
export type Contact = {
	address: string;
	name: string;
	custom?: boolean;
	/** The safety number (60 digits) the user confirmed. Cleared if it stops matching the current keys. */
	verified?: string;
	/** A verified contact's safety number changed; a warning shows until the user dismisses it. */
	keyChanged?: boolean;
	/** A message request: someone I have not added and have not written to. Shown in Requests, not in chats. */
	request?: boolean;
	/** Requests only: the first message came without proof of work (an old client, or a sender that skipped it). */
	unverified?: boolean;
};
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
	/** Time (ms) of the last manual "Retry" on a failed own message; the 24 h pending window restarts from it. */
	retried?: number;
	reply?: Reply;
	/** Photo, GIF or video. `text` is then the caption (may be empty). Own messages also keep the blob delete token. */
	att?: Att;
	/** Time (ms) of the last edit; set means the bubble shows "edited". Only the latest text is kept. */
	edited?: number;
	/** Own messages: the peer's device stored it ('delivered') or its user looked at it ('read'). */
	delivery?: 'delivered' | 'read';
	/** Received messages: this device already handled the read receipt (sent it, or receipts are off). */
	seen?: boolean;
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
const KEY_RECEIPTS = 'miga.receipts';
const KEY_LIVE = 'miga.live';
const KEY_FILTERED = 'miga.filtered';
const KEY_STRICT = 'miga.strict';
const KEY_UNREAD = 'miga.unread';
const KEY_MUTED = 'miga.muted';
const KEY_NOTIFY = 'miga.notify';
const KEY_NOTIFY_BANNER = 'miga.notify-banner';
const KEY_TOMBS = 'miga.tombs';
const KEY_HX = 'miga.hx';
const KEY_BACKUP = 'miga.backup';

/** What a notification shows: sender and text, sender only (default), or nothing but "New message". */
export type NotifyMode = 'full' | 'name' | 'generic';
const NOTIFY_MODES: NotifyMode[] = ['full', 'name', 'generic'];

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

/** Read receipts (send and show). Off by default: anonymity first. */
export function loadReceipts(): boolean {
	try {
		return localStorage.getItem(KEY_RECEIPTS) === '1';
	} catch {
		return false;
	}
}

/** Show what I type live (this device only). Off by default: the other side sees unfinished words. */
export function loadLive(): boolean {
	try {
		return localStorage.getItem(KEY_LIVE) === '1';
	} catch {
		return false;
	}
}

export function saveLive(on: boolean): void {
	try {
		localStorage.setItem(KEY_LIVE, on ? '1' : '0');
	} catch {
		// Ignored: the setting just does not persist.
	}
}

/** Messages from unknown senders dropped because their proof of work was invalid (or missing in strict mode). */
export function loadFiltered(): number {
	try {
		return Math.max(0, Math.min(999_999, Math.floor(Number(localStorage.getItem(KEY_FILTERED)) || 0)));
	} catch {
		return 0;
	}
}

export function saveFiltered(n: number): void {
	try {
		localStorage.setItem(KEY_FILTERED, String(Math.max(0, Math.floor(n))));
	} catch {
		// Ignored: the counter just does not persist.
	}
}

/** Strict requests: unknown senders without proof of work are filtered instead of shown as "unverified". */
export function loadStrict(): boolean {
	try {
		return localStorage.getItem(KEY_STRICT) === '1';
	} catch {
		return false;
	}
}

export function saveStrict(on: boolean): void {
	try {
		localStorage.setItem(KEY_STRICT, on ? '1' : '0');
	} catch {
		// Ignored: the setting just does not persist.
	}
}

/** Notification content (per device, not synced: it depends on this device's screen and system). */
export function loadNotifyMode(): NotifyMode {
	try {
		const v = localStorage.getItem(KEY_NOTIFY);
		return NOTIFY_MODES.includes(v as NotifyMode) ? (v as NotifyMode) : 'name';
	} catch {
		return 'name';
	}
}

export function saveNotifyMode(mode: NotifyMode): void {
	try {
		localStorage.setItem(KEY_NOTIFY, mode);
	} catch {
		// Storage can be blocked; the default applies next time.
	}
}

/** The user dismissed the "turn on notifications" banner. */
export function loadNotifyBannerDismissed(): boolean {
	try {
		return localStorage.getItem(KEY_NOTIFY_BANNER) === '1';
	} catch {
		return false;
	}
}

export function saveNotifyBannerDismissed(): void {
	try {
		localStorage.setItem(KEY_NOTIFY_BANNER, '1');
	} catch {
		// Ignored: the banner may come back.
	}
}

export function saveReceipts(on: boolean): void {
	localStorage.setItem(KEY_RECEIPTS, on ? '1' : '0');
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

/**
 * When the key was last backed up on this device, and how. Only the time and the kind are kept, never
 * the file or the passphrase. `restored` means the account came from a backup, so one exists.
 */
export type BackupInfo = { ts: number; kind: 'file' | 'code' | 'restored' };

export function loadBackupInfo(): BackupInfo | null {
	const stored = readJson<Partial<BackupInfo> | null>(KEY_BACKUP, null);
	if (!stored || typeof stored.ts !== 'number' || !Number.isFinite(stored.ts)) return null;
	const kind = stored.kind === 'code' || stored.kind === 'restored' ? stored.kind : 'file';
	return { ts: stored.ts, kind };
}

export function saveBackupInfo(info: BackupInfo): void {
	try {
		localStorage.setItem(KEY_BACKUP, JSON.stringify(info));
	} catch {
		// Storage can be blocked; the reminder just stays.
	}
}

/** Resolves when every queued database write has been committed (before a page reload). */
export async function flushWrites(): Promise<void> {
	await writeQueue.catch(() => {});
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
		KEY_BLOCKED,
		KEY_RECEIPTS,
		KEY_FILTERED,
		KEY_UNREAD,
		KEY_MUTED,
		KEY_NOTIFY,
		KEY_NOTIFY_BANNER,
		KEY_TOMBS,
		KEY_HX,
		KEY_BACKUP,
		RECENT_EMOJI_KEY
	]) {
		localStorage.removeItem(key);
	}
}

// ── Contacts, blocked list and chats (IndexedDB, with a localStorage fallback) ────────────

export type Unread = Record<string, number>;
export type AppData = {
	contacts: Contact[];
	chats: Chats;
	blocked: string[];
	/** Unread incoming messages per chat. Kept next to the chats so it survives a reload. */
	unread: Unread;
	/** Chats that count unread messages but never notify. */
	muted: string[];
	/** Remembered deletes (see sync.ts). Old ones are pruned on load. */
	tombs: Tomb[];
	/** An unfinished history copy from another device, if any. */
	hx: HistoryJob | null;
};

let db: IDBDatabase | null = null;
let erased = false;
/** Writes run one after another so a later save never overtakes an earlier one. */
let writeQueue: Promise<unknown> = Promise.resolve();
/** JSON of what is already stored, to write only what changed. */
let storedMessages = new Map<string, string>();
let storedContacts = new Map<string, string>();
let storedBlocked = '';
let storedUnread = '';
let storedMuted = '';
let storedTombs = '';
let storedHx = '';

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

function cleanUnread(stored: unknown): Unread {
	const out: Unread = {};
	if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
		for (const [peer, n] of Object.entries(stored)) {
			if (isAddress(peer) && typeof n === 'number' && n > 0) out[peer] = Math.min(Math.floor(n), 99999);
		}
	}
	return out;
}

function legacyData(): AppData {
	return {
		unread: cleanUnread(readJson<unknown>(KEY_UNREAD, {})),
		muted: cleanBlocked(readJson<unknown>(KEY_MUTED, [])),
		contacts: readJson<Contact[]>(KEY_CONTACTS, []),
		chats: readJson<Chats>(KEY_CHATS, {}),
		blocked: cleanBlocked(readJson<unknown>(KEY_BLOCKED, [])),
		tombs: cleanTombs(readJson<unknown>(KEY_TOMBS, [])),
		hx: cleanHistoryJob(readJson<unknown>(KEY_HX, null))
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
			const unread = cleanUnread(await req(t.objectStore('meta').get('unread')));
			const muted = cleanBlocked(await req(t.objectStore('meta').get('muted')));
			const tombs = cleanTombs(await req(t.objectStore('meta').get('tombs')));
			const hx = cleanHistoryJob(await req(t.objectStore('meta').get('hx')));
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
			storedUnread = JSON.stringify(unread);
			storedMuted = JSON.stringify(muted);
			pruneTombs(tombs);
			storedTombs = JSON.stringify(tombs);
			storedHx = JSON.stringify(hx);
			void navigator.storage?.persist?.();
			return { contacts, chats, blocked, unread, muted, tombs, hx };
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

/** Unread counters per chat (small, rewritten whole). */
export function saveUnread(unread: Unread): void {
	if (erased) return;
	if (!db) return void localStorage.setItem(KEY_UNREAD, JSON.stringify(unread));
	const json = JSON.stringify(unread);
	queue(async () => {
		if (json === storedUnread) return;
		await tx(db!, ['meta'], 'readwrite', (t) => void t.objectStore('meta').put(unread, 'unread'));
		storedUnread = json;
	});
}

/** Muted chats (addresses). */
export function saveMuted(muted: string[]): void {
	if (erased) return;
	if (!db) return void localStorage.setItem(KEY_MUTED, JSON.stringify(muted));
	const json = JSON.stringify(muted);
	queue(async () => {
		if (json === storedMuted) return;
		await tx(db!, ['meta'], 'readwrite', (t) => void t.objectStore('meta').put(muted, 'muted'));
		storedMuted = json;
	});
}

/** Delete tombstones (small, rewritten whole when they change). */
export function saveTombs(tombs: Tomb[]): void {
	if (erased) return;
	if (!db) return void localStorage.setItem(KEY_TOMBS, JSON.stringify(tombs));
	const json = JSON.stringify(tombs);
	queue(async () => {
		if (json === storedTombs) return;
		await tx(db!, ['meta'], 'readwrite', (t) => void t.objectStore('meta').put(tombs, 'tombs'));
		storedTombs = json;
	});
}

/** Progress of the history copy on a newly linked device; null removes it. */
export function saveHx(job: HistoryJob | null): void {
	if (erased) return;
	if (!db) {
		if (job) localStorage.setItem(KEY_HX, JSON.stringify(job));
		else localStorage.removeItem(KEY_HX);
		return;
	}
	const json = JSON.stringify(job);
	queue(async () => {
		if (json === storedHx) return;
		await tx(db!, ['meta'], 'readwrite', (t) => {
			if (job) t.objectStore('meta').put(job, 'hx');
			else t.objectStore('meta').delete('hx');
		});
		storedHx = json;
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
