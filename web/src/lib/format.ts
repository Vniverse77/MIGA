import { getLanguage } from './i18n.svelte';

/** A date in the language of the interface (Turkmen uses the Turkish format, as elsewhere in the app). */
export const dateOf = (ts: number): string =>
	new Date(ts).toLocaleDateString(getLanguage() === 'en' ? [] : getLanguage() === 'tk' ? 'tr' : getLanguage());

export function sizeOf(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}
