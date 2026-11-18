// Emoji helpers that run in the main bundle (the picker itself is loaded on demand).

const RECENT_KEY = 'miga.emoji-recent';
export const MAX_RECENT = 24;

/** Most recently used emoji, newest first. Per device; empty when storage is blocked. */
export function loadRecentEmoji(): string[] {
	try {
		const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
		return Array.isArray(raw)
			? raw.filter((e): e is string => typeof e === 'string' && e.length > 0 && e.length < 40).slice(0, MAX_RECENT)
			: [];
	} catch {
		return [];
	}
}

export function pushRecentEmoji(emoji: string): string[] {
	const next = [emoji, ...loadRecentEmoji().filter((e) => e !== emoji)].slice(0, MAX_RECENT);
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		// Storage can be blocked; the list just does not persist.
	}
	return next;
}

export const RECENT_EMOJI_KEY = RECENT_KEY;

// One emoji "character" as the user sees it: a flag, a keycap, or a pictograph with optional
// skin tone / variation selector / ZWJ sequence parts.
const PART = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣\u{E0020}-\u{E007F}]+$/u;
const START = /^(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Emoji_Presentation}|\p{Extended_Pictographic}️)/u;

let segmenter: Intl.Segmenter | null | undefined;

/**
 * True when the text is 1 to 3 emoji and nothing else (spaces between them are ignored).
 * Uses grapheme segmentation, so a family, a flag or a skin-toned hand counts as one.
 * A bare (c), (r) or a digit is not an emoji unless it is written in emoji form.
 */
export function isEmojiOnly(text: string): boolean {
	if (segmenter === undefined) {
		try {
			segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
		} catch {
			segmenter = null;
		}
	}
	if (!segmenter || !text || text.length > 200) return false;
	let count = 0;
	for (const { segment } of segmenter.segment(text)) {
		if (/^\s+$/u.test(segment)) continue;
		if (!START.test(segment) || !PART.test(segment) && !/^[#*0-9]️?⃣$/u.test(segment)) return false;
		if (++count > 3) return false;
	}
	return count > 0;
}
