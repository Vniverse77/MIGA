// Typing visibility: a three-way choice instead of one toggle, and the throttle of the tiny `typing`
// frame. Pure helpers (no storage, no network) so the rules can be tested.

/** off = nothing leaves this device; typing = "typing..." only; live = the unfinished text itself. */
export type TypingMode = 'off' | 'typing' | 'live';

/** A `typing` frame is repeated at most this often while the person keeps typing. */
export const TYPING_REFRESH_MS = 3000;
/** The receiver forgets "typing" this long after the last frame (a lost stop frame must not stick). */
export const TYPING_EXPIRE_MS = 6000;

const isMode = (v: unknown): v is TypingMode => v === 'off' || v === 'typing' || v === 'live';

/**
 * The stored mode. Missing (an older version): the old live-text toggle decides, so someone who had
 * live text on keeps it and everyone else gets the typing indicator.
 */
export function resolveTypingMode(stored: string | null, legacyLive: string | null): TypingMode {
	if (isMode(stored)) return stored;
	return legacyLive === '1' ? 'live' : 'typing';
}

export type TypingState = { peer: string | null; active: boolean; at: number };
export type TypingFrame = { to: string; typing: boolean };
export const TYPING_IDLE: TypingState = { peer: null, active: false, at: 0 };

/**
 * One step of the sender. `peer` is null when nothing may be sent right now (setting off, no focus,
 * other chat, blocked ...); `hasText` says whether the box holds anything. Returns the next state and
 * the frames to send: a start frame, a refresh at most every TYPING_REFRESH_MS, and a stop frame when
 * the box empties, the chat changes or sending becomes impossible.
 */
export function typingStep(
	prev: TypingState,
	peer: string | null,
	hasText: boolean,
	now: number
): { state: TypingState; frames: TypingFrame[] } {
	const frames: TypingFrame[] = [];
	if (prev.peer && prev.active && (prev.peer !== peer || !hasText)) frames.push({ to: prev.peer, typing: false });
	if (!peer) return { state: TYPING_IDLE, frames };
	if (!hasText) return { state: { peer, active: false, at: 0 }, frames };
	const same = prev.peer === peer && prev.active;
	if (!same || now - prev.at >= TYPING_REFRESH_MS) {
		frames.push({ to: peer, typing: true });
		return { state: { peer, active: true, at: now }, frames };
	}
	return { state: { peer, active: true, at: prev.at }, frames };
}
