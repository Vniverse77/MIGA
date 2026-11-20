// Tiny IndexedDB layer. Holds everything that can grow (messages, contacts, blocked list);
// identity, device keys and other small settings stay in localStorage (see storage.ts).
//
// Stores:
//   messages  key [chat, id]; indexes chat_i = [chat, i] (arrival order) and chat_ts = [chat, ts]
//             (for per-chat search and history paging later). One record per message, so a single
//             new message writes one small record instead of rewriting a whole chat.
//   contacts  key address; `i` keeps the list order.
//   meta      key name; small values such as the blocked list and the migration marker.
//   media     key id; local copies of sent and received attachments (P6).
//   gifs      key id; the user's own GIF library ("My GIFs"), device only (v2).
//   groups    key gid; group records (v3). gmessages key [gid, id]: group messages. gout key wid: copies of group
//             payloads still to be delivered. Kept apart from `messages`, so the 1:1 chat code never sees them.

const DB_NAME = 'miga';
const DB_VERSION = 3;

export type MessageRecord = { chat: string; id: string; i: number; ts: number } & Record<string, unknown>;

export function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains('messages')) {
				const messages = db.createObjectStore('messages', { keyPath: ['chat', 'id'] });
				messages.createIndex('chat_i', ['chat', 'i']);
				messages.createIndex('chat_ts', ['chat', 'ts']);
			}
			if (!db.objectStoreNames.contains('contacts')) db.createObjectStore('contacts', { keyPath: 'address' });
			if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
			if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
			if (!db.objectStoreNames.contains('gifs')) db.createObjectStore('gifs', { keyPath: 'id' });
			if (!db.objectStoreNames.contains('groups')) db.createObjectStore('groups', { keyPath: 'gid' });
			if (!db.objectStoreNames.contains('gmessages')) db.createObjectStore('gmessages', { keyPath: ['gid', 'id'] });
			if (!db.objectStoreNames.contains('gout')) db.createObjectStore('gout', { keyPath: 'wid' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error('indexedDB blocked'));
	});
}

/** Runs `work` in one transaction and resolves when it has committed. */
export function tx<T>(
	db: IDBDatabase,
	stores: string[],
	mode: IDBTransactionMode,
	work: (t: IDBTransaction) => Promise<T> | T
): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = db.transaction(stores, mode);
		let result: T;
		t.oncomplete = () => resolve(result);
		t.onerror = () => reject(t.error);
		t.onabort = () => reject(t.error ?? new Error('aborted'));
		Promise.resolve(work(t)).then((r) => (result = r), reject);
	});
}

/** Awaits one request. */
export function req<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

/** Removes the whole database (used when the account is erased). */
export function deleteDb(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof indexedDB === 'undefined') return resolve();
		const r = indexedDB.deleteDatabase(DB_NAME);
		r.onsuccess = r.onerror = r.onblocked = () => resolve();
	});
}
