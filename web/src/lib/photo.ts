// Profile photos. The own photo and the photos of contacts live in IndexedDB (`meta`), on this device
// only. A photo goes to a contact as an ordinary encrypted attachment referenced from a `photo`
// control message (see crypto.ts, docs/PROTOCOL.md); the relay never sees it in the clear.
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import type { Att } from './attach';
import { openDb, req, tx } from './db';
import { sniffMime } from './attach';

/** Side of the stored and shared picture. */
export const PHOTO_SIZE = 256;

export type OwnPhoto = {
	blob: Blob;
	/** SHA-256 of the bytes, hex. Contacts refetch only when this changes. */
	hash: string;
	/** The uploaded, encrypted copy shared with contacts and linked devices (re-made when old). */
	att?: Att;
	attTs?: number;
};
export type PeerPhoto = { blob: Blob; hash: string; att?: Att };

const memory = new Map<string, unknown>();
let dbp: Promise<IDBDatabase | null> | null = null;
const getDb = () => (dbp ??= openDb().catch(() => null));

async function get<T>(key: string): Promise<T | undefined> {
	if (memory.has(key)) return memory.get(key) as T;
	const db = await getDb();
	if (!db) return undefined;
	try {
		const v = (await tx(db, ['meta'], 'readonly', (t) => req(t.objectStore('meta').get(key)))) as T | undefined;
		if (v !== undefined) memory.set(key, v);
		return v;
	} catch {
		return undefined;
	}
}

async function put(key: string, value: unknown): Promise<void> {
	memory.set(key, value);
	const db = await getDb();
	if (db) await tx(db, ['meta'], 'readwrite', (t) => void t.objectStore('meta').put(value, key)).catch(() => {});
}

async function del(key: string): Promise<void> {
	memory.delete(key);
	const db = await getDb();
	if (db) await tx(db, ['meta'], 'readwrite', (t) => void t.objectStore('meta').delete(key)).catch(() => {});
}

export const hashBytes = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

export const loadOwnPhoto = () => get<OwnPhoto>('photo:own');
export const saveOwnPhoto = (p: OwnPhoto) => put('photo:own', p);
export const clearOwnPhoto = () => del('photo:own');
export const loadPeerPhoto = (address: string) => get<PeerPhoto>('photo:' + address);
export const savePeerPhoto = (address: string, p: PeerPhoto) => put('photo:' + address, p);
export const clearPeerPhoto = (address: string) => del('photo:' + address);

/** Which photo version (hash, or '' for "nothing") each contact was last told about. Device-local. */
export const loadPhotoSent = async () => (await get<Record<string, string>>('photo:sent')) ?? {};
export const savePhotoSent = (m: Record<string, string>) => put('photo:sent', m);

/** Wipes every stored photo (account erase). The whole database is removed anyway; this clears memory. */
export function forgetPhotos(): void {
	memory.clear();
}

// ── Picking and cropping ─────────────────────────────────────────────────────────────────

export type View = { zoom: number; x: number; y: number };

/**
 * The square source rectangle of an image of `w` x `h` for a view. `zoom` 1 = the biggest centered
 * square; `x`, `y` in -1..1 move it within the free room. Pure, so it can be tested.
 */
export function cropRect(w: number, h: number, v: View): { sx: number; sy: number; side: number } {
	const zoom = Math.min(8, Math.max(1, Number.isFinite(v.zoom) ? v.zoom : 1));
	const side = Math.min(w, h) / zoom;
	const cl = (n: number) => Math.min(1, Math.max(-1, Number.isFinite(n) ? n : 0));
	const sx = (w - side) / 2 + (cl(v.x) * (w - side)) / 2;
	const sy = (h - side) / 2 + (cl(v.y) * (h - side)) / 2;
	return { sx, sy, side };
}

/** Decodes a picked image (rotation applied). Throws when it is not a readable still image. */
export async function openImage(file: Blob): Promise<ImageBitmap> {
	if (file.size === 0 || file.size > 25 * 1024 * 1024) throw new Error('size');
	const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
	if (!/^image\/(jpeg|png|webp|gif|heic)$/.test(sniffMime(head))) throw new Error('type');
	return createImageBitmap(file, { imageOrientation: 'from-image' });
}

/** Draws the chosen part into `canvas` (PHOTO_SIZE square). Used for the preview and the result. */
export function drawCrop(canvas: HTMLCanvasElement, bmp: ImageBitmap, v: View, size = PHOTO_SIZE): void {
	canvas.width = size;
	canvas.height = size;
	const g = canvas.getContext('2d')!;
	g.fillStyle = '#fff';
	g.fillRect(0, 0, size, size);
	g.imageSmoothingQuality = 'high';
	const { sx, sy, side } = cropRect(bmp.width, bmp.height, v);
	g.drawImage(bmp, sx, sy, side, side, 0, 0, size, size);
}

/** Re-encodes the crop as WebP (JPEG as fallback). Re-drawing on a canvas drops every metadata block (EXIF, GPS). */
export async function encodeCrop(bmp: ImageBitmap, v: View): Promise<{ blob: Blob; hash: string }> {
	const c = document.createElement('canvas');
	drawCrop(c, bmp, v);
	const toBlob = (type: string) => new Promise<Blob | null>((r) => c.toBlob(r, type, 0.86));
	let blob = await toBlob('image/webp');
	if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg');
	if (!blob) throw new Error('encode');
	return { blob, hash: hashBytes(new Uint8Array(await blob.arrayBuffer())) };
}
