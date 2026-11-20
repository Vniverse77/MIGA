// Small private groups (at most 5 members): state, signatures, validation and pure transitions.
// See docs/PROTOCOL.md, "Groups (v1)". Nothing here touches the network or storage, so it can be tested alone.
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { cleanAtt, type Att } from './attach';
import { cleanReply, isAddress, MAX_TEXT, type Identity, type Reply } from './crypto';

export const MAX_MEMBERS = 5;
export const MAX_BANNED = 50;
export const MAX_GROUP_NAME = 40;
export const MAX_GROUP_DELETE = 50;
export const MAX_GONE = 300;
const SIG_DOMAIN = 'miga-group-v1\0';
const GID = /^[0-9a-f]{32}$/;
const MSG_ID = /^[0-9a-f]{32}$/;

export type GroupState = {
	id: string;
	name: string;
	admin: string;
	members: string[];
	banned: string[];
	epoch: number;
	createdAt: number;
};

/** invited: waiting for my accept (a request); active: I am in; removed/banned/left: I am out (record kept against replays). */
export type GroupStatus = 'invited' | 'active' | 'removed' | 'banned' | 'left';

/** Everything this device knows about one group. `accepted`, `left`, `muted` and `status` are local, never signed. */
export type GroupRecord = {
	state: GroupState;
	/** Signature over `state`, and the address that made it (the admin before a transfer, else `state.admin`). */
	sig: string;
	signer: string;
	status: GroupStatus;
	/** The invite came from someone who is not my contact: it sits in Requests until accepted. */
	request?: boolean;
	unverified?: boolean;
	/** Members that confirmed they joined (the admin always counts). */
	accepted: string[];
	/** Members that announced `leave` and are waiting for the admin's new state. */
	left: string[];
	muted?: boolean;
	since: number;
	/** Ids of messages deleted here (newest last, at most MAX_GONE): a redelivery or a sync copy must not bring them back. */
	gone?: string[];
	/** Highest epoch for which I already asked the admin for the state. */
	wanted?: number;
};

export type GroupMessage = {
	gid: string;
	id: string;
	from: string;
	mine: boolean;
	text: string;
	ts: number;
	att?: Att;
	reply?: Reply;
	mentions?: string[];
	/** Received: I am mentioned. A muted group still notifies for it. */
	mentionsMe?: boolean;
	name?: string;
	edited?: number;
	/** Own messages: delivery of each copy, by member address. */
	to?: Record<string, 'pending' | 'sent' | 'failed'>;
};

/** Sync between my own devices (sealed with the account sync key, like the other kinds). */
export type GroupSync =
	| { k: 'grp'; rec: GroupRecord }
	| { k: 'gmsg'; gid: string; message: GroupMessage }
	| { k: 'gdel'; gid: string; ids: string[] }
	| { k: 'gedit'; gid: string; id: string; text: string; ts: number };

export type GroupErrorCode =
	| 'not_admin'
	| 'full'
	| 'banned'
	| 'not_member'
	| 'already_member'
	| 'bad_name'
	| 'bad_address'
	| 'not_active'
	| 'transfer_first'
	| 'unknown_group'
	| 'bad_message';

export class GroupError extends Error {
	constructor(public code: GroupErrorCode) {
		super(code);
	}
}

export const isGid = (v: unknown): v is string => typeof v === 'string' && GID.test(v);
export const isMsgId = (v: unknown): v is string => typeof v === 'string' && MSG_ID.test(v);

export function cleanGroupName(value: unknown): string {
	return typeof value === 'string' ? [...value.trim().replace(/\s+/g, ' ')].slice(0, MAX_GROUP_NAME).join('') : '';
}

const sortedUnique = (list: string[]) => [...new Set(list)].sort();

/** The exact string that is signed: fixed key order, sorted lists, no whitespace. */
export function canonicalState(st: GroupState): string {
	return JSON.stringify({
		id: st.id,
		name: st.name,
		admin: st.admin,
		members: sortedUnique(st.members),
		banned: sortedUnique(st.banned),
		epoch: st.epoch,
		createdAt: st.createdAt
	});
}

/** `signer` must be the admin the receivers know: for a transfer that is the OLD admin, not `st.admin`. */
export function signState(signer: Identity, st: GroupState, expected: string = st.admin): string {
	if (signer.address !== expected) throw new GroupError('not_admin');
	return bytesToHex(ed25519.sign(utf8ToBytes(SIG_DOMAIN + canonicalState(st)), signer.secret));
}

/** True when `sig` is `signer`'s signature over `st`. */
export function verifyState(st: GroupState, sig: unknown, signer: string): boolean {
	if (typeof sig !== 'string' || !/^[0-9a-f]{128}$/.test(sig)) return false;
	try {
		return ed25519.verify(hexToBytes(sig), utf8ToBytes(SIG_DOMAIN + canonicalState(st)), hexToBytes(signer));
	} catch {
		return false;
	}
}

/** Validates a state from the network or storage. Null when malformed or when an invariant is broken. */
export function cleanState(value: unknown): GroupState | null {
	const s = (value ?? {}) as Partial<GroupState>;
	if (!isGid(s.id)) return null;
	const name = cleanGroupName(s.name);
	if (!name || typeof s.admin !== 'string' || !isAddress(s.admin)) return null;
	if (!Array.isArray(s.members) || !Array.isArray(s.banned)) return null;
	if (s.members.length < 1 || s.members.length > MAX_MEMBERS || s.banned.length > MAX_BANNED) return null;
	const addr = (a: unknown): a is string => typeof a === 'string' && isAddress(a);
	if (!s.members.every(addr) || !s.banned.every(addr)) return null;
	const members = sortedUnique(s.members as string[]);
	const banned = sortedUnique(s.banned as string[]);
	if (members.length !== s.members.length || banned.length !== s.banned.length) return null;
	if (!members.includes(s.admin) || banned.some((b) => members.includes(b))) return null;
	if (!Number.isInteger(s.epoch) || (s.epoch as number) < 1 || (s.epoch as number) > 2 ** 31) return null;
	const createdAt = Number(s.createdAt);
	if (!Number.isFinite(createdAt) || createdAt < 0) return null;
	return { id: s.id, name, admin: s.admin, members, banned, epoch: s.epoch as number, createdAt };
}

// ── Pure admin transitions: they only build the next unsigned state ──────────────────────────

export function newState(admin: string, name: string, now: number, id: string): GroupState {
	const clean = cleanGroupName(name);
	if (!clean) throw new GroupError('bad_name');
	return { id, name: clean, admin, members: [admin], banned: [], epoch: 1, createdAt: now };
}

export function withMember(st: GroupState, address: string): GroupState {
	if (!isAddress(address)) throw new GroupError('bad_address');
	if (st.banned.includes(address)) throw new GroupError('banned');
	if (st.members.includes(address)) throw new GroupError('already_member');
	if (st.members.length >= MAX_MEMBERS) throw new GroupError('full');
	return { ...st, members: sortedUnique([...st.members, address]), epoch: st.epoch + 1 };
}

/** Removes a member; `ban` also adds it to the banned list. The admin cannot be removed (transfer first). */
export function withoutMember(st: GroupState, address: string, ban = false): GroupState {
	if (address === st.admin) throw new GroupError('transfer_first');
	if (!st.members.includes(address)) throw new GroupError('not_member');
	const banned = ban ? sortedUnique([...st.banned, address]).slice(-MAX_BANNED) : st.banned;
	return { ...st, members: st.members.filter((m) => m !== address), banned, epoch: st.epoch + 1 };
}

export function renamed(st: GroupState, name: string): GroupState {
	const clean = cleanGroupName(name);
	if (!clean) throw new GroupError('bad_name');
	return { ...st, name: clean, epoch: st.epoch + 1 };
}

export function transferred(st: GroupState, to: string): GroupState {
	if (!st.members.includes(to) || to === st.admin) throw new GroupError('not_member');
	return { ...st, admin: to, epoch: st.epoch + 1 };
}

// ── Receiving a signed state ─────────────────────────────────────────────────────────────────

export type StateVerdict =
	| { ok: true; state: GroupState }
	| { ok: false; reason: 'malformed' | 'stale' | 'bad_signature' | 'wrong_sender' };

/**
 * Should `sender` be believed about this state? `known` is what I have for this group (if anything).
 * The signer is the admin I already know; for an unknown group it is the admin named in the state, and
 * that must be the sender of the envelope (an invite comes straight from the admin). `viaSync` (my own
 * device sent it) skips the sender check; the signature is still verified.
 */
export function judgeState(
	known: Pick<GroupRecord, 'state'> | undefined,
	incoming: { st: unknown; sig: unknown },
	sender: string,
	viaSync = false
): StateVerdict {
	const state = cleanState(incoming.st);
	if (!state) return { ok: false, reason: 'malformed' };
	if (known && known.state.id !== state.id) return { ok: false, reason: 'malformed' };
	if (known && state.epoch <= known.state.epoch) return { ok: false, reason: 'stale' };
	const signer = known ? known.state.admin : state.admin;
	if (!verifyState(state, incoming.sig, signer)) return { ok: false, reason: 'bad_signature' };
	if (!viaSync && sender !== signer) return { ok: false, reason: 'wrong_sender' };
	return { ok: true, state };
}

// ── Content helpers ──────────────────────────────────────────────────────────────────────────

/** Mentions: members only, no duplicates, at most 5. */
export function cleanMentions(value: unknown, members: string[]): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((a): a is string => typeof a === 'string' && members.includes(a)))].slice(0, MAX_MEMBERS);
}

export const cleanMsgIds = (value: unknown): string[] =>
	Array.isArray(value) ? [...new Set(value.filter(isMsgId))].slice(0, MAX_GROUP_DELETE) : [];

const cleanMsgIds2 = (v: unknown[]): string[] => v.filter(isMsgId).slice(-MAX_GONE);

/** Per-recipient relay id: the relay's `sent` frame carries only an id, so every copy needs its own. */
export function wireId(gid: string, key: string, recipient: string): string {
	return bytesToHex(sha256(utf8ToBytes(`${gid}:${key}:${recipient}`))).slice(0, 32);
}

/** Validates a stored or synced record. Verifies the signature, so a forged sync cannot plant a group. */
export function cleanRecord(value: unknown): GroupRecord | null {
	const r = (value ?? {}) as Partial<GroupRecord>;
	const state = cleanState(r.state);
	if (!state || typeof r.signer !== 'string' || !isAddress(r.signer) || !verifyState(state, r.sig, r.signer)) return null;
	const statuses: GroupStatus[] = ['invited', 'active', 'removed', 'banned', 'left'];
	if (!statuses.includes(r.status as GroupStatus)) return null;
	const inState = (list: unknown) =>
		Array.isArray(list) ? sortedUnique(list.filter((a): a is string => typeof a === 'string' && state.members.includes(a))) : [];
	return {
		state,
		sig: r.sig as string,
		signer: r.signer,
		status: r.status as GroupStatus,
		...(r.request === true ? { request: true } : {}),
		...(r.request === true && r.unverified === true ? { unverified: true } : {}),
		accepted: inState(r.accepted),
		left: inState(r.left),
		...(r.muted === true ? { muted: true } : {}),
		since: Number(r.since) || 0,
		...(Array.isArray(r.gone) && r.gone.length ? { gone: cleanMsgIds2(r.gone) } : {}),
		...(Number.isInteger(r.wanted) ? { wanted: r.wanted } : {})
	};
}

/** Validates a group message from storage or another device. */
export function cleanGroupMessage(value: unknown, gid: string, members: string[]): GroupMessage | null {
	const m = (value ?? {}) as Partial<GroupMessage>;
	if (!isMsgId(m.id) || typeof m.from !== 'string' || !isAddress(m.from) || typeof m.mine !== 'boolean') return null;
	if (typeof m.text !== 'string' || m.text.length > MAX_TEXT) return null;
	const att = m.att === undefined ? undefined : cleanAtt(m.att, true);
	if (m.att !== undefined && !att) return null;
	const reply = m.reply === undefined ? undefined : cleanReply(m.reply);
	const to: GroupMessage['to'] = {};
	for (const [a, s] of Object.entries(m.to ?? {})) {
		if (isAddress(a) && (s === 'pending' || s === 'sent' || s === 'failed')) to[a] = s;
	}
	return {
		gid,
		id: m.id,
		from: m.from,
		mine: m.mine,
		text: m.text,
		ts: Number(m.ts) || Date.now(),
		...(att ? { att } : {}),
		...(reply ? { reply } : {}),
		...(cleanMentions(m.mentions, members).length ? { mentions: cleanMentions(m.mentions, members) } : {}),
		...(m.mentionsMe === true ? { mentionsMe: true } : {}),
		...(typeof m.name === 'string' && m.name ? { name: m.name.slice(0, 40) } : {}),
		...(Number(m.edited) > 0 ? { edited: Number(m.edited) } : {}),
		...(m.mine && Object.keys(to).length ? { to } : {})
	};
}
