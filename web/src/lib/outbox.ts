// Retry schedule and state decisions for outgoing chat messages. Pure, so it can be tested without a relay.
//
// A message is `pending` until the relay answers `sent`. While pending it is sent again after 2 s, 5 s,
// 15 s, 30 s and then every 60 s, and at every reconnect. The id never changes, so the relay and the
// receiver drop duplicates. After 24 h without an answer it becomes `failed` and the person decides.

export const RETRY_STEPS_MS = [2_000, 5_000, 15_000, 30_000] as const;
export const RETRY_REPEAT_MS = 60_000;
export const FAIL_AFTER_MS = 24 * 60 * 60 * 1000;

/** Wait before the next try, given how many tries were made so far (1 = the first send). */
export function retryDelay(attempts: number): number {
	const i = Math.max(0, attempts - 1);
	return i < RETRY_STEPS_MS.length ? RETRY_STEPS_MS[i] : RETRY_REPEAT_MS;
}

export type Track = { attempts: number; nextAt: number };
export type OutMessage = { state: string; ts: number; retried?: number };

/** `wait`: not yet, `send`: try now, `fail`: give up and show Retry/Delete, `skip`: not pending. */
export function nextStep(m: OutMessage, track: Track | undefined, now: number): 'wait' | 'send' | 'fail' | 'skip' {
	if (m.state !== 'pending') return 'skip';
	if (now - (m.retried ?? m.ts) >= FAIL_AFTER_MS) return 'fail';
	if (!track || now >= track.nextAt) return 'send';
	return 'wait';
}

/** Book-keeping after a send that really went onto the wire. */
export function afterSend(track: Track | undefined, now: number): Track {
	const attempts = (track?.attempts ?? 0) + 1;
	return { attempts, nextAt: now + retryDelay(attempts) };
}
