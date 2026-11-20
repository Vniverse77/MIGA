// Copy and paste that work in every build. The web clipboard API needs a secure context, focus and a
// user gesture, and the WebKitGTK and Android WebViews of the packaged apps are strict about all three, so
// the order is: the shell's native clipboard, then navigator.clipboard, then a hidden textarea with execCommand.
import { platform } from './platform';

/** Copies text. Resolves true only when one method really put it on the clipboard. */
export async function copyText(text: string): Promise<boolean> {
	if (platform.clipboard) {
		try {
			await platform.clipboard.writeText(text);
			return true;
		} catch {
			/* fall through to the web methods */
		}
	}
	try {
		if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		/* blocked: try the legacy path */
	}
	return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
	if (typeof document === 'undefined') return false;
	const active = document.activeElement as HTMLElement | null;
	const box = document.createElement('textarea');
	box.value = text;
	box.setAttribute('readonly', '');
	box.setAttribute('aria-hidden', 'true');
	box.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;user-select:text;-webkit-user-select:text';
	document.body.appendChild(box);
	try {
		box.focus({ preventScroll: true });
		box.select();
		box.setSelectionRange(0, text.length);
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		box.remove();
		active?.focus?.({ preventScroll: true });
	}
}

/** True when the page may use the web clipboard API (a secure context); packaged builds have the native one. */
export const clipboardAvailable = (): boolean =>
	!!platform.clipboard || (typeof window !== 'undefined' && window.isSecureContext);

const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function named(file: File, i: number): File {
	if (file.name) return file;
	return new File([file], `pasted-${i + 1}.${EXT[file.type] ?? 'png'}`, { type: file.type });
}

/** Image files in a paste or drop: `files` first, then file items (some browsers fill only one of the two). */
export function imagesFrom(data: DataTransfer | null | undefined): File[] {
	if (!data) return [];
	const out: File[] = [];
	const seen = new Set<string>();
	const add = (f: File | null | undefined) => {
		if (!f || !IMAGE.test(f.type)) return;
		const k = `${f.type}:${f.size}:${f.name}`;
		if (seen.has(k)) return;
		seen.add(k);
		out.push(named(f, out.length));
	};
	for (const f of data.files ?? []) add(f);
	for (const item of data.items ?? []) if (item.kind === 'file') add(item.getAsFile());
	return out;
}

/** Image from the clipboard when the paste event itself carried none (WebKitGTK, shell with a native clipboard). */
export async function nativeImage(): Promise<File | null> {
	try {
		const bytes = await platform.clipboard?.readImage?.();
		if (!bytes?.length) return null;
		return new File([bytes as BlobPart], 'pasted-1.png', { type: 'image/png' });
	} catch {
		return null;
	}
}
