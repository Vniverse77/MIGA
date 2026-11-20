// Pure helpers for the group screens: mentions, member colours, permissions, previews.
// No DOM, no network, so they are unit tested (group-ui.test.ts). See docs/PROTOCOL.md, "Groups (v1)".
import { MAX_MEMBERS, type GroupMessage, type GroupRecord, type SysLine } from './groups';

/** Eight member colours (CSS variables --gm-0..7 hold the light and dark values). */
export const MEMBER_COLORS = 8;

/** The colour slot of a member: by position in the sorted member list, so colours inside one group never collide (up to 8). */
export function memberColor(members: string[], address: string): number {
	const i = [...new Set(members)].sort().indexOf(address);
	return (i < 0 ? 0 : i) % MEMBER_COLORS;
}

// ── Mentions ────────────────────────────────────────────────────────────────────────────────

/** In the text a mention is `@Name` with spaces turned into `_`, so one token never contains whitespace. */
export const mentionToken = (name: string): string => '@' + name.trim().replace(/\s+/g, '_');
const norm = (s: string) => s.trim().replace(/\s+/g, '_').toLowerCase();
const TOKEN = /@[^\s@]+/gu;
/** Mention tokens of a text; trailing punctuation ("@Name," "@Name!") is not part of the name. */
function tokensOf(text: string): { index: number; raw: string }[] {
	const out: { index: number; raw: string }[] = [];
	for (const m of text.matchAll(TOKEN)) {
		const raw = m[0].replace(/[.,!?;:)\]}"'…]+$/u, '');
		if (raw.length > 1) out.push({ index: m.index ?? 0, raw });
	}
	return out;
}

export type Candidate = { address: string; name: string };

/** The open `@query` at the caret: where it starts and what was typed after it. Null when the caret is not in one. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
	const before = text.slice(0, caret);
	const at = before.lastIndexOf('@');
	if (at < 0) return null;
	if (at > 0 && !/\s/u.test(before[at - 1])) return null; // part of an e-mail address or a word
	const query = before.slice(at + 1);
	if (/\s/u.test(query) || query.length > 40) return null;
	return { start: at, query };
}

/** Members whose name starts with (or contains) the query, prefix matches first. */
export function filterCandidates(list: Candidate[], query: string): Candidate[] {
	const q = norm(query);
	if (!q) return list;
	const starts = list.filter((c) => norm(c.name).startsWith(q));
	const has = list.filter((c) => !norm(c.name).startsWith(q) && norm(c.name).includes(q));
	return [...starts, ...has];
}

/** Replaces `@query` at [start, caret) by the full token and a space. Returns the new text and caret. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
	const token = mentionToken(name) + ' ';
	return { text: text.slice(0, start) + token + text.slice(caret), caret: start + token.length };
}

/** Addresses named in `text` (a token must equal a member's name exactly), in order, no duplicates, at most MAX_MEMBERS. */
export function parseMentions(text: string, candidates: Candidate[]): string[] {
	const out: string[] = [];
	for (const m of tokensOf(text)) {
		const name = norm(m.raw.slice(1));
		const hit = candidates.find((c) => norm(c.name) === name);
		if (hit && !out.includes(hit.address)) out.push(hit.address);
	}
	return out.slice(0, MAX_MEMBERS);
}

export type Part = { t: string; mention?: string };

/**
 * Splits a message into plain parts and mention chips. A token becomes a chip when its name matches a mentioned member
 * (by this device's name for them); a token that matches nobody is assigned by position to a mentioned member that
 * has no chip yet (the sender may know them under another name). Without mentions, text stays plain.
 */
export function mentionParts(text: string, mentions: string[] | undefined, nameOf: (address: string) => string): Part[] {
	if (!mentions?.length) return [{ t: text }];
	const tokens = tokensOf(text);
	const taken = new Set<string>();
	const assigned = new Map<number, string>();
	tokens.forEach((m, i) => {
		const hit = mentions.find((a) => !taken.has(a) && norm(nameOf(a)) === norm(m.raw.slice(1)));
		if (hit) (assigned.set(i, hit), taken.add(hit));
	});
	tokens.forEach((_, i) => {
		if (assigned.has(i)) return;
		const rest = mentions.find((a) => !taken.has(a));
		if (rest) (assigned.set(i, rest), taken.add(rest));
	});
	const parts: Part[] = [];
	let at = 0;
	tokens.forEach((m, i) => {
		const who = assigned.get(i);
		if (!who) return;
		const from = m.index;
		if (from > at) parts.push({ t: text.slice(at, from) });
		parts.push({ t: '@' + nameOf(who), mention: who });
		at = from + m.raw.length;
	});
	if (at < text.length) parts.push({ t: text.slice(at) });
	return parts.length ? parts : [{ t: text }];
}

// ── Permissions ─────────────────────────────────────────────────────────────────────────────

export type MemberAction = 'remove' | 'ban' | 'admin';

export const isAdmin = (rec: GroupRecord, me: string): boolean => rec.state.admin === me && rec.status === 'active';

/** What the viewer may do to `target`: only the admin acts, never on themselves. */
export function memberActions(rec: GroupRecord, me: string, target: string): MemberAction[] {
	if (!isAdmin(rec, me) || target === me || !rec.state.members.includes(target)) return [];
	return ['admin', 'remove', 'ban'];
}

/** The admin may edit the name, ban and unban. A member may leave and mute. */
export const canRename = (rec: GroupRecord, me: string): boolean => isAdmin(rec, me);
export const canInvite = (rec: GroupRecord, me: string): boolean => isAdmin(rec, me) && rec.state.members.length < MAX_MEMBERS;
/** Slots still free for new members (an invite is a pending member, so it counts). */
export const freeSlots = (rec: GroupRecord): number => Math.max(0, MAX_MEMBERS - rec.state.members.length);
/** The admin cannot leave while others remain: hand the group over first. */
export const mustTransferBeforeLeaving = (rec: GroupRecord, me: string): boolean => rec.state.admin === me && rec.state.members.some((m) => m !== me);
export const canWrite = (rec: GroupRecord): boolean => rec.status === 'active';

/** Members the creator can pick from: contacts only, never requests or blocked people. */
export function pickableContacts<T extends { address: string; request?: boolean }>(contacts: T[], blocked: string[]): T[] {
	return contacts.filter((c) => !c.request && !blocked.includes(c.address));
}

/** The new group needs a name and 1..4 invitees (a group of one is not a group). */
export function canCreate(name: string, picked: number): boolean {
	return name.trim().length > 0 && picked >= 1 && picked <= MAX_MEMBERS - 1;
}

// ── Text of rows and system lines ───────────────────────────────────────────────────────────

/** "Name: text" for the chat list; a system line is shown as it reads in the chat. */
export function rowPreview(m: GroupMessage | undefined, nameOf: (a: string) => string, sysText: (s: SysLine) => string, attLabel: string, mineLabel: string): string {
	if (!m) return '';
	if (m.sys) return sysText(m.sys);
	const who = m.mine ? mineLabel : nameOf(m.from);
	const body = m.text.trim() || attLabel;
	return `${who}: ${body}`;
}

/** The newest message that is not a system line counts for unread and ordering of previews. */
export const isChatMessage = (m: GroupMessage): boolean => !m.sys;
