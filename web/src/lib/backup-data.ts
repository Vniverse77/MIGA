// What goes into a backup file and what comes back out of one. The container (encryption, header) is
// backup.ts; this file decides the content and treats a restored file as untrusted input, the same way
// the sync code treats data from another device.
import { BackupError, KIND_FILE, open, seal } from './backup';
import { MAX_TEXT, bytesToHex, hexToBytes, identityFromSecret, isAddress, type Identity } from './crypto';
import { cleanBlocked, cleanContact, cleanMessage, cleanProfile } from './devices';
import type { Chats, Contact, NotifyMode, Profile } from './storage';

export type BackupSettings = { receipts: boolean; live: boolean; notify: NotifyMode };

/** The JSON inside a backup file. Everything except `secret` is optional. */
export type BackupContent = {
	v: 1;
	/** Unix ms. */
	created: number;
	/** Account secret key, 64 hex characters. */
	secret: string;
	profile?: Profile;
	contacts?: Contact[];
	blocked?: string[];
	muted?: string[];
	settings?: BackupSettings;
	chats?: Chats;
};

/** What this device holds right now; the backup dialog picks from it. */
export type Snapshot = {
	profile: Profile;
	contacts: Contact[];
	blocked: string[];
	muted: string[];
	chats: Chats;
	settings: BackupSettings;
};

export type Choice = {
	/** Contacts, profile, block and mute lists, settings. */
	extras: boolean;
	/** Message history. Attachments are not included (they are not stored in the page data). */
	history: boolean;
};

export function buildBackup(identity: Identity, data: Snapshot, choice: Choice, now = Date.now()): BackupContent {
	const content: BackupContent = { v: 1, created: now, secret: bytesToHex(identity.secret) };
	if (choice.extras) {
		content.profile = data.profile;
		content.contacts = data.contacts.map(({ keyChanged: _dropped, ...contact }) => contact);
		content.blocked = data.blocked;
		content.muted = data.muted;
		content.settings = data.settings;
	}
	if (choice.history) {
		const chats: Chats = {};
		for (const [peer, list] of Object.entries(data.chats)) {
			// A photo or video without a caption would come back as an empty bubble.
			const keep = list.filter((m) => !m.att || m.text).map(({ att: _att, ...m }) => m);
			if (keep.length) chats[peer] = keep;
		}
		content.chats = chats;
	}
	return content;
}

export const backupFileName = (now = new Date()): string =>
	`miga-backup-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.miga`;

export function encodeBackup(content: BackupContent, passphrase: string): Promise<Uint8Array> {
	return seal(KIND_FILE, new TextEncoder().encode(JSON.stringify(content)), passphrase);
}

/** Opens and validates a backup file. Throws BackupError. */
export async function decodeBackup(bytes: Uint8Array, passphrase: string): Promise<BackupContent> {
	const { kind, payload } = await open(bytes, passphrase);
	if (kind !== KIND_FILE) throw new BackupError('format');
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder().decode(payload));
	} catch {
		throw new BackupError('format');
	}
	return cleanBackup(json);
}

const NOTIFY: NotifyMode[] = ['full', 'name', 'generic'];

export function cleanBackup(value: unknown): BackupContent {
	const raw = (value ?? {}) as Record<string, unknown>;
	if (raw.v !== 1 || typeof raw.secret !== 'string' || !/^[0-9a-f]{64}$/.test(raw.secret)) {
		throw new BackupError('format');
	}
	try {
		identityFromSecret(hexToBytes(raw.secret));
	} catch {
		throw new BackupError('format');
	}
	const out: BackupContent = { v: 1, created: Number(raw.created) || 0, secret: raw.secret };
	if (raw.profile !== undefined) out.profile = cleanProfile(raw.profile);
	if (Array.isArray(raw.contacts)) {
		const seen = new Set<string>();
		out.contacts = [];
		for (const item of raw.contacts.slice(0, 5000)) {
			const contact = cleanContact(item);
			if (contact && !seen.has(contact.address)) (seen.add(contact.address), out.contacts.push(contact));
		}
	}
	if (raw.blocked !== undefined) out.blocked = cleanBlocked(raw.blocked);
	if (raw.muted !== undefined) out.muted = cleanBlocked(raw.muted);
	const settings = (raw.settings ?? null) as Partial<BackupSettings> | null;
	if (settings && typeof settings === 'object') {
		out.settings = {
			receipts: settings.receipts === true,
			live: settings.live === true,
			notify: NOTIFY.includes(settings.notify as NotifyMode) ? (settings.notify as NotifyMode) : 'name'
		};
	}
	if (raw.chats && typeof raw.chats === 'object' && !Array.isArray(raw.chats)) {
		out.chats = {};
		for (const [peer, list] of Object.entries(raw.chats)) {
			if (!Array.isArray(list) || !isAddress(peer)) continue;
			const messages = list.map((m) => cleanMessage(m, MAX_TEXT)).filter((m) => m !== null);
			if (messages.length) out.chats[peer] = messages;
		}
	}
	return out;
}

/** Contacts of the backup that this device does not know yet are added; known ones are left alone. */
export function mergeContacts(have: Contact[], incoming: Contact[]): Contact[] {
	const known = new Set(have.map((c) => c.address));
	return [...have, ...incoming.filter((c) => !known.has(c.address))];
}
