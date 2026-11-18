// Sending and fetching attachments: image processing, upload/download, local media store.
import { MAX_ATTACHMENT, MAX_EDGE, cleanAtt, decryptFile, encryptFile, isAnimated, sniffMime, type Att } from './attach';
import { platform } from './platform';
import { openDb, req, tx } from './db';

export class AttachError extends Error {
	constructor(public code: 'too_big' | 'unsupported' | 'decode' | 'upload' | 'quota' | 'rate' | 'network' | 'gone' | 'corrupt' | 'cancelled') {
		super(code);
	}
}

/** HTTP base of the relay that serves the page / the WebSocket. */
export function blobBase(): string {
	const u = new URL(platform.relayUrl());
	u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
	u.pathname = '/blob';
	u.search = '';
	return u.toString();
}

export type Prepared = {
	bytes: Uint8Array;
	mime: string;
	w: number;
	h: number;
	thumb: string;
};

async function bitmapOf(blob: Blob): Promise<ImageBitmap> {
	try {
		return await createImageBitmap(blob);
	} catch {
		throw new AttachError('decode');
	}
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	return new Promise((res) => canvas.toBlob(res, type, quality));
}

/** A tiny blurred preview: 24 px wide, under 2 KB. Empty string when it cannot be made. */
async function makeThumb(source: CanvasImageSource, w: number, h: number): Promise<string> {
	try {
		const tw = 24;
		const th = Math.max(1, Math.round((h / w) * tw));
		const c = document.createElement('canvas');
		c.width = tw;
		c.height = th;
		c.getContext('2d')!.drawImage(source, 0, 0, tw, th);
		for (const [type, q] of [['image/webp', 0.5], ['image/jpeg', 0.5], ['image/jpeg', 0.3]] as const) {
			const blob = await canvasBlob(c, type, q);
			if (!blob) continue;
			const url = await new Promise<string>((res) => {
				const r = new FileReader();
				r.onload = () => res(String(r.result));
				r.readAsDataURL(blob);
			});
			if (url.length < 2000) return url;
		}
	} catch {
		// A missing preview is fine.
	}
	return '';
}

async function videoInfo(file: Blob): Promise<{ w: number; h: number; thumb: string }> {
	const url = URL.createObjectURL(file);
	try {
		const v = document.createElement('video');
		v.muted = true;
		v.preload = 'auto';
		v.src = url;
		await new Promise<void>((res, rej) => {
			v.onloadeddata = () => res();
			v.onerror = () => rej(new AttachError('decode'));
			setTimeout(() => rej(new AttachError('decode')), 8000);
		});
		const w = v.videoWidth || 640;
		const h = v.videoHeight || 360;
		return { w, h, thumb: await makeThumb(v, w, h) };
	} finally {
		URL.revokeObjectURL(url);
	}
}

/**
 * Turns a picked file into what gets encrypted.
 * Photos are decoded and redrawn on a canvas (longest edge at most 2048 px), which drops all
 * metadata (EXIF, GPS, camera). Animated GIF/WebP/PNG and MP4/WebM go out unchanged, so the animation
 * survives; those files can carry metadata (MP4 and WebM especially), which is NOT removed.
 */
export async function prepare(file: Blob): Promise<Prepared> {
	if (file.size > MAX_ATTACHMENT) throw new AttachError('too_big');
	if (file.size === 0) throw new AttachError('unsupported');
	const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
	const mime = sniffMime(head);
	if (!mime) throw new AttachError('unsupported');

	if (mime === 'video/mp4' || mime === 'video/webm') {
		const info = await videoInfo(file);
		return { bytes: new Uint8Array(await file.arrayBuffer()), mime, ...info };
	}
	// Animated pictures are sent as they are.
	if (isAnimated(head, mime)) {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const bmp = await bitmapOf(new Blob([bytes], { type: mime }));
		const out = { bytes, mime, w: bmp.width, h: bmp.height, thumb: await makeThumb(bmp, bmp.width, bmp.height) };
		bmp.close();
		return out;
	}
	const bmp = await bitmapOf(file);
	try {
		const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
		const w = Math.max(1, Math.round(bmp.width * scale));
		const h = Math.max(1, Math.round(bmp.height * scale));
		const c = document.createElement('canvas');
		c.width = w;
		c.height = h;
		c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
		const thumb = await makeThumb(c, w, h);
		// WebP when the browser can make it (keeps transparency), else JPEG on white.
		let blob = await canvasBlob(c, 'image/webp', 0.85);
		if (!blob || blob.type !== 'image/webp') {
			const flat = document.createElement('canvas');
			flat.width = w;
			flat.height = h;
			const g = flat.getContext('2d')!;
			g.fillStyle = '#fff';
			g.fillRect(0, 0, w, h);
			g.drawImage(c, 0, 0);
			blob = await canvasBlob(flat, 'image/jpeg', 0.85);
		}
		if (!blob) throw new AttachError('decode');
		return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, w, h, thumb };
	} finally {
		bmp.close();
	}
}

export type Upload = { promise: Promise<Att>; cancel: () => void };

/** Encrypts and uploads. `onProgress` gets 0..1. The promise resolves with the full message metadata. */
export function upload(p: Prepared, onProgress: (f: number) => void, reuse?: { cipher: Uint8Array; att: Omit<Att, 'blob' | 'del'> }): Upload & { sealed: { cipher: Uint8Array; att: Omit<Att, 'blob' | 'del'> } } {
	const sealed =
		reuse ??
		(() => {
			const e = encryptFile(p.bytes);
			return { cipher: e.cipher, att: { key: e.key, nonce: e.nonce, hash: e.hash, mime: p.mime, size: p.bytes.length, w: p.w, h: p.h, thumb: p.thumb } };
		})();
	const xhr = new XMLHttpRequest();
	const promise = new Promise<Att>((resolve, reject) => {
		xhr.open('PUT', blobBase());
		xhr.responseType = 'json';
		xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
		xhr.onload = () => {
			if (xhr.status === 201 && xhr.response?.id) {
				resolve({ ...sealed.att, blob: xhr.response.id, del: xhr.response.del });
			} else if (xhr.status === 413) reject(new AttachError('too_big'));
			else if (xhr.status === 507) reject(new AttachError('quota'));
			else if (xhr.status === 429) reject(new AttachError('rate'));
			else reject(new AttachError('upload'));
		};
		xhr.onerror = () => reject(new AttachError('network'));
		xhr.onabort = () => reject(new AttachError('cancelled'));
		xhr.send(new Blob([sealed.cipher as BlobPart]));
	});
	return { promise, cancel: () => xhr.abort(), sealed };
}

/** Deletes a blob on the relay (sender only, needs the delete token). Never throws. */
export async function deleteRemote(att: Att): Promise<void> {
	if (!att.del) return;
	try {
		await fetch(`${blobBase()}/${att.blob}`, { method: 'DELETE', headers: { 'X-Delete-Token': att.del } });
	} catch {
		// The blob expires on its own after 30 days.
	}
}

// ── Local media store (IndexedDB `media`, in-memory when IndexedDB is unavailable) ──────

type MediaRecord = { id: string; mime: string; data: Blob; ts: number };
const memory = new Map<string, MediaRecord>();
let dbp: Promise<IDBDatabase | null> | null = null;
const getDb = () => (dbp ??= openDb().catch(() => null));

export async function saveMedia(id: string, data: Blob, mime: string): Promise<void> {
	const rec: MediaRecord = { id, mime, data, ts: Date.now() };
	memory.set(id, rec);
	const db = await getDb();
	if (db) {
		try {
			await tx(db, ['media'], 'readwrite', (t) => void t.objectStore('media').put(rec));
		} catch {
			// Quota or private mode: it stays in memory for this session.
		}
	}
}

export async function loadMedia(id: string): Promise<Blob | null> {
	const hit = memory.get(id);
	if (hit) return hit.data;
	const db = await getDb();
	if (!db) return null;
	try {
		const rec = (await tx(db, ['media'], 'readonly', (t) => req(t.objectStore('media').get(id)))) as MediaRecord | undefined;
		if (rec?.data) {
			memory.set(id, rec);
			return rec.data;
		}
	} catch {
		// Treated as missing.
	}
	return null;
}

export async function mediaIds(): Promise<string[]> {
	const db = await getDb();
	if (!db) return [...memory.keys()];
	try {
		return (await tx(db, ['media'], 'readonly', (t) => req(t.objectStore('media').getAllKeys()))) as string[];
	} catch {
		return [];
	}
}

export async function deleteMedia(ids: string[]): Promise<void> {
	for (const id of ids) memory.delete(id);
	const db = await getDb();
	if (db && ids.length) {
		try {
			await tx(db, ['media'], 'readwrite', (t) => void ids.forEach((id) => t.objectStore('media').delete(id)));
		} catch {
			// Retried by the next cleanup pass.
		}
	}
}

const inflight = new Map<string, Promise<Blob>>();

/** Gets a received attachment: from the local store, else download + decrypt + verify + store. */
export function fetchMedia(att: Att): Promise<Blob> {
	const running = inflight.get(att.blob);
	if (running) return running;
	const job = (async () => {
		const local = await loadMedia(att.blob);
		if (local) return local;
		let res: Response;
		try {
			res = await fetch(`${blobBase()}/${att.blob}`);
		} catch {
			throw new AttachError('network');
		}
		if (res.status === 404) throw new AttachError('gone');
		if (!res.ok) throw new AttachError('network');
		let plain: Uint8Array;
		try {
			plain = decryptFile(new Uint8Array(await res.arrayBuffer()), att);
		} catch (e) {
			if (e instanceof AttachError) throw e;
			throw new AttachError('corrupt');
		}
		const blob = new Blob([plain as BlobPart], { type: att.mime });
		await saveMedia(att.blob, blob, att.mime);
		return blob;
	})().finally(() => inflight.delete(att.blob));
	inflight.set(att.blob, job);
	return job;
}

export { cleanAtt };
