// Message requests: who may reach me directly and who waits in the Requests inbox. Pure rules, so they can be
// tested without a relay or a browser. See docs/PROTOCOL.md, "Message requests and first contact".
import { verifyPow, type Pow } from './pow';
import type { Contact, Message } from './storage';

/**
 * What to do with a (new, non-control) message from `from`:
 * - `contact`: a contact I added or accepted: normal chat.
 * - `request`: stranger with a valid proof of work: Requests.
 * - `unverified`: stranger without any proof (an older client): Requests, with an "unverified" badge.
 * - `filtered`: stranger whose proof is wrong, or with no proof while strict mode is on: dropped, only counted.
 */
export type Verdict = 'contact' | 'request' | 'unverified' | 'filtered';

export function classify(opts: {
	contact: Pick<Contact, 'request' | 'unverified'> | undefined;
	pow: Pow | undefined;
	from: string;
	me: string;
	ts: number;
	strict: boolean;
}): Verdict {
	const { contact, pow, from, me, ts, strict } = opts;
	// Someone I added, accepted, or who is already waiting in Requests (it was judged on its first message).
	if (contact) return contact.request ? (contact.unverified ? 'unverified' : 'request') : 'contact';
	if (pow) return verifyPow(pow, from, me, ts) ? 'request' : 'filtered';
	return strict ? 'filtered' : 'unverified';
}

/**
 * Do my messages to `peer` need a proof of work? Yes until the peer has written to me once (it then knows
 * me, and a reply is not a first contact). A request I have not accepted is never written to at all.
 */
export function needsPow(chat: Message[] | undefined): boolean {
	return !chat?.some((m) => !m.mine);
}

/** Cache key of a solved proof: one per recipient and day. */
export const powKey = (recipient: string, day: number): string => `${recipient}:${day}`;
