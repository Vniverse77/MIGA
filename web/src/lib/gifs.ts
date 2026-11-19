// "My GIFs": the user's own GIF library. Files live only in this device's IndexedDB (store `gifs`)
// and never leave it except when the user sends one, through the normal encrypted attachment path.
// The default set ships in static/gifs/ and is fetched only when the GIF panel opens.
import { openDb, req, tx } from './db';
import { MAX_ATTACHMENT, sniffMime } from './attach';

type GifRecord = { id: string; mime: string; data: Blob; ts: number };
export type MyGif = { id: string; mime: string; data: Blob };

/** Default brand GIFs (animated WebP, about 8 MB in all). Names are file stems in static/gifs/. */
export const DEFAULT_GIFS = Array.from({ length: 13 }, (_, i) => `gif-${String(i + 1).padStart(2, '0')}`);
export const defaultUrl = (name: string) => `/gifs/${name}.webp`;

/** Largest file kept in the library (smaller than a chat attachment: it is a convenience copy). */
export const MAX_GIF = Math.min(MAX_ATTACHMENT, 8 * 1024 * 1024);
const HIDDEN_KEY = 'miga.gifs-hidden';
const memory = new Map<string, GifRecord>();
let dbp: Promise<IDBDatabase | null> | null = null;
const getDb = () => (dbp ??= openDb().catch(() => null));

export function loadHidden(): string[] {
	try {
		const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]');
		return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];
	} catch {
		return [];
	}
}

export function saveHidden(list: string[]): void {
	try {
		if (list.length) localStorage.setItem(HIDDEN_KEY, JSON.stringify(list));
		else localStorage.removeItem(HIDDEN_KEY);
	} catch {
		// Storage blocked: the choice lasts until reload.
	}
}

/** All of the user's GIFs, newest first. */
export async function listGifs(): Promise<MyGif[]> {
	const db = await getDb();
	let recs: GifRecord[];
	if (db) {
		try {
			recs = (await tx(db, ['gifs'], 'readonly', (t) => req(t.objectStore('gifs').getAll()))) as GifRecord[];
		} catch {
			recs = [...memory.values()];
		}
	} else recs = [...memory.values()];
	return recs.sort((a, b) => b.ts - a.ts).map(({ id, mime, data }) => ({ id, mime, data }));
}

export type AddResult = 'ok' | 'unsupported' | 'too_big';

/** Adds one picked, dropped or pasted file. Only GIF, WebP and PNG pictures are accepted. */
export async function addGif(file: Blob): Promise<AddResult> {
	if (file.size === 0) return 'unsupported';
	if (file.size > MAX_GIF) return 'too_big';
	const mime = sniffMime(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
	if (mime !== 'image/gif' && mime !== 'image/webp') return 'unsupported';
	const id = crypto.randomUUID();
	const rec: GifRecord = { id, mime, data: new Blob([file], { type: mime }), ts: Date.now() };
	memory.set(id, rec);
	const db = await getDb();
	if (db) {
		try {
			await tx(db, ['gifs'], 'readwrite', (t) => void t.objectStore('gifs').put(rec));
		} catch {
			// Quota or private mode: it stays in memory for this session.
		}
	}
	return 'ok';
}

export async function removeGif(id: string): Promise<void> {
	memory.delete(id);
	const db = await getDb();
	if (!db) return;
	try {
		await tx(db, ['gifs'], 'readwrite', (t) => void t.objectStore('gifs').delete(id));
	} catch {
		// Nothing to do; it is gone from memory.
	}
}

/** Fetches one default GIF as a file ready for the attachment path. */
export async function defaultFile(name: string): Promise<File> {
	const res = await fetch(defaultUrl(name));
	if (!res.ok) throw new Error('fetch failed');
	return new File([await res.blob()], `${name}.webp`, { type: 'image/webp' });
}
