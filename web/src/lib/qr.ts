// QR codes are only a carrier for text the app already knows how to handle:
// `<origin>/app/#link=<code>` (add a device), `<origin>/app/#to=<address>` (add a contact) and
// `<origin>/app/#verify=<60 digits>` (safety number check).
// Nothing here talks to a server.
import { renderSVG } from 'uqr';
import { isAddress, isSafetyNumber } from './crypto';
import { normalizeLinkCode } from './devices';

/** What a scanned QR code may ask the app to do. Anything else is rejected. */
export type Scanned =
	| { kind: 'link'; code: string }
	| { kind: 'to'; address: string; name: string }
	| { kind: 'verify'; number: string };

/** Dark on light with a four-module white border, so it also scans from a dark-themed screen. */
export function qrSvg(text: string): string {
	return renderSVG(text, { ecc: 'M', border: 4 }).replace('<svg ', '<svg shape-rendering="crispEdges" ');
}

/** Link to open the app on `origin` with the given fragment parameters. */
export function appUrl(origin: string, params: Record<string, string>): string {
	return `${origin}/app/#${new URLSearchParams(params)}`;
}

/** Accepts only our own two formats; the host is not checked, so self-hosted relays work. */
export function parseScanned(text: string): Scanned | null {
	let hash: string;
	try {
		hash = new URL(text.trim()).hash;
	} catch {
		return null;
	}
	const params = new URLSearchParams(hash.slice(1));
	const code = params.get('link');
	if (code !== null) {
		const normal = normalizeLinkCode(code);
		return normal ? { kind: 'link', code: normal } : null;
	}
	const verify = params.get('verify');
	if (verify !== null) return isSafetyNumber(verify) ? { kind: 'verify', number: verify } : null;
	const address = (params.get('to') ?? '').trim().toLowerCase();
	if (!isAddress(address)) return null;
	return { kind: 'to', address, name: (params.get('name') ?? '').trim().slice(0, 40) };
}

/** Finds a QR code in a picture; null when there is none. The decoder is loaded on first use. */
export async function decodeQr(image: ImageData): Promise<string | null> {
	const { default: jsQR } = await import('jsqr');
	return jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}
