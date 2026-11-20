// Link previews, the part that talks to the native shell (desktop and Android). The browser build has no fetcher,
// so nothing is ever fetched there. See preview.ts for the design.
import { platform } from './platform';
import { parseMeta, type PageMeta } from './preview';
import { prepare, type Prepared } from './media';

/** True where previews can be made at all (apps with the native fetcher). */
export const previewsAvailable = (): boolean => !!platform.linkPreview;

export type Fetched = { meta: PageMeta; image: Prepared | null };

/**
 * Fetches the page behind `url` and its picture. Returns null when there is nothing worth showing or the fetch
 * failed (private address, timeout, not HTML ...). The picture is shrunk to 512 px and re-encoded, which drops
 * every piece of metadata. Failures of the picture alone only mean "no image".
 */
export async function fetchLinkPreview(url: string): Promise<Fetched | null> {
	const native = platform.linkPreview;
	if (!native) return null;
	try {
		const page = await native.page(url);
		// Names come from the page the person typed, not from where redirects led.
		const meta = parseMeta(page.html, page.url);
		if (!meta.title && !meta.desc) return null;
		let image: Prepared | null = null;
		if (meta.image) {
			try {
				const bytes = await native.image(meta.image);
				image = await prepare(new Blob([bytes as BlobPart]), { maxEdge: 512, still: true });
			} catch {
				image = null;
			}
		}
		if (image && image.bytes.length > 300_000) image = null;
		return { meta, image };
	} catch {
		return null;
	}
}
