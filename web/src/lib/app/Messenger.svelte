<script lang="ts">
	import { platform } from '../platform';
import ConfirmDialog, { ask, askText } from './ConfirmDialog.svelte';
	import QrCode from './QrCode.svelte';
	import Attachment from './Attachment.svelte';
	import Viewer from './Viewer.svelte';
	import { MAX_ATTACHMENT, type Att } from '../attach';
	import { AttachError, deleteMedia, deleteRemote, mediaIds, prepare, saveMedia, upload, type Prepared } from '../media';
	import Scanner from './Scanner.svelte';
	import { GLOBAL_LIMIT, messageKey, searchAll, searchMessages, segments, snippet } from '../search';
	import { appUrl, type Scanned } from '../qr';
	import { linkify } from '../links';
	import { VERSION_LABEL, VERSION_TITLE } from '../version';
	import { onMount, tick, untrack } from 'svelte';
	import {
		bytesToHex,
		applyEdit,
		cleanReply,
		decrypt,
		editTime,
		encrypt,
		encryptDelete,
		encryptEdit,
		encryptLive,
		encryptReceipt,
		MAX_TEXT,
		MAX_DELETE,
		cleanIds,
		hexToBytes,
		identityFromSecret,
		groupSafety,
		isAddress,
		randomId,
		safetyNumber,
		type Identity,
		type Reply
	} from '../crypto';
	import {
		LINK_TTL_MS,
		cleanBlocked,
		cleanContact,
		cleanDeleteItems,
		cleanDevices,
		cleanMessage,
		cleanProfile,
		deriveLink,
		formatLinkCode,
		guessDeviceLabel,
		mergeMessages,
		newLinkCode,
		normalizeLinkCode,
		open,
		removeMessages,
		seal,
		syncKey,
		type LinkBundle,
		type SyncMessage
	} from '../devices';
	import {
		addTombs,
		applyTombs,
		cleanCursor,
		cleanTombs,
		clearContactTomb,
		contactTombTs,
		countMessages,
		historyPage,
		historyPercent,
		tombFilter,
		type HistoryJob,
		type Tomb
	} from '../sync';
	import Logo from '../Logo.svelte';
	import Icon from './Icon.svelte';
	import { getTheme, setTheme, type Theme } from '../theme.svelte';
	import { getLanguage, t } from '../i18n.svelte';
	import { isEmojiOnly } from '../emoji';
	import type { Component } from 'svelte';
	import type { NotifyPermission } from '../platform/types';
	import LangSelect from '../LangSelect.svelte';
	import { RelayClient, type Incoming, type RelayEvents, type Status } from '../relay';
	import {
		MAX_BLOCKED,
		createIdentity,
		eraseAll,
		loadData,
		loadLive,
		saveLive,
		loadDevice,
		loadDevices,
		loadIdentity,
		loadOpenLink,
		loadProfile,
		loadNotifyBannerDismissed,
		loadNotifyMode,
		loadReceipts,
		saveBlocked,
		saveChats,
		saveContacts,
		saveDevices,
		saveHx,
		saveTombs,
		saveIdentity,
		saveOpenLink,
		saveProfile,
		saveMuted,
		saveNotifyBannerDismissed,
		saveNotifyMode,
		saveReceipts,
		saveUnread,
		type Chats,
		type Contact,
		type Device,
		type Message,
		type NotifyMode,
		type Profile,
		type Unread
	} from '../storage';

	/** Sync traffic is paced to stay well under the relay's limit of 30 sends per 10 seconds. */
	const OUTBOX_MS = 400;
	const LINK_WAIT_MS = 30_000;
	const LINK_CONNECT_MS = 7_000;

	let identity = $state.raw<Identity | null>(null);
	let status = $state<Status>('offline');
	let contacts = $state<Contact[]>([]);
	let chats = $state<Chats>({});
	let profile = $state<Profile>({ name: '', share: true });
	let devices = $state<Device[]>([]);
	let blocked = $state<string[]>([]);
	/** Read receipts: send mine and show theirs. Off by default (anonymity first). */
	let receipts = $state(false);
	/** Send what I type live (ephemeral frames). This device only, off by default. */
	let liveOn = $state(false);
	/** What the open chat's other side is typing right now (never stored, never a message). */
	let liveIn = $state<{ peer: string; text: string } | null>(null);
	let liveInTimer: ReturnType<typeof setTimeout> | undefined;
	let composerFocused = $state(false);
	/** Unread incoming messages per chat; persisted with the chats. Control messages never count. */
	let unread = $state<Unread>({});
	/** Muted chats still count unread messages but never notify. Synced to linked devices. */
	let muted = $state<string[]>([]);
	let notifyMode = $state<NotifyMode>('name');
	let notifyPerm = $state<NotifyPermission>('unsupported');
	let bannerDismissed = $state(true);
	/** document.visibilityState === 'visible'; read receipts are only sent while the chat can be seen. */
	let visible = $state(true);
	let active = $state<string | null>(null);
	let view = $state<'chat' | 'settings' | 'new' | 'verify'>('chat');
	/** Result of the last scan on the safety number screen. */
	let verifyResult = $state<'match' | 'mismatch' | null>(null);
	let menuOpen = $state(false);
	/** Action menu of one message (button, long-press). */
	let msgMenu = $state<{ x: number; y: number; message: Message; at: number } | null>(null);
	let msgMenuEl = $state<HTMLElement | null>(null);
	/** Desktop right-click menu on a conversation row. */
	let ctx = $state<{ x: number; y: number; address: string } | null>(null);
	const isDesktop = platform.target === 'desktop';
	function toggleSettings(): void {
		view = view === 'settings' ? 'chat' : 'settings';
	}
	let ready = $state(false);
	let draft = $state('');
	/** The message the next one will quote. */
	let replyTo = $state<Reply | null>(null);
	let composerInput = $state<HTMLTextAreaElement | null>(null);
	/** Set while the composer edits one of my own messages. */
	let editing = $state<{ peer: string; id: string; text: string } | null>(null);
	let emojiOpen = $state(false);
	let gifOpen = $state(false);
	// Attachments: uploads in progress (heavy bytes live in uploadData, not in reactive state).
	type UploadItem = {
		key: string;
		peer: string;
		caption: string;
		reply?: Reply;
		ts: number;
		state: 'preparing' | 'sending' | 'failed';
		progress: number;
		error: string;
		thumb: string;
		w: number;
		h: number;
	};
	let uploads = $state<UploadItem[]>([]);
	const uploadData = new Map<string, { prepared?: Prepared; sealed?: ReturnType<typeof upload>['sealed']; cancel?: () => void }>();
	let fileInput = $state<HTMLInputElement | null>(null);
	let dragging = $state(false);
	let attError = $state('');
	let attErrorTimer: ReturnType<typeof setTimeout> | undefined;
	let viewer = $state<{ url: string; mime: string } | null>(null);
	/** The picker is a separate chunk, fetched the first time it is opened. */
	let EmojiPicker = $state.raw<Component<{ onpick: (emoji: string) => void }> | null>(null);
	let GifPanel = $state.raw<Component<{ onsend: (file: File) => void; onnotice: (text: string) => void }> | null>(null);
	let highlighted = $state('');
	let newAddress = $state('');
	let newName = $state('');
	let notice = $state('');
	let scroller = $state<HTMLElement | null>(null);

	// First-run screen
	let onboard = $state<'create' | 'link'>('create');
	let codeInput = $state('');
	let linking = $state(false);
	/** The QR scanner is open for this kind of code, or not open. */
	let scanning = $state<'link' | 'to' | 'verify' | null>(null);

	// "Add a device" on a device that already has the account
	let link = $state<{ code: string } | null>(null);
	let linkNotice = $state('');
	let deviceLabel = $state('');

	/** Copy of history from another device in progress (new device), or null. Saved, so it resumes. */
	let hx = $state<HistoryJob | null>(null);
	/** Shows "100%" for a few seconds after the copy finished. */
	let hxFlash = $state(false);
	let hxFlashTimer: ReturnType<typeof setTimeout> | undefined;
	const hxPercent = $derived(hx ? historyPercent(hx) : 100);
	/** The request waiting for an answer; an answer with another `q` is stale and ignored. */
	let hxPending: { q: string; at: number } | null = null;
	let hxTry = 0;
	let hxTimer: ReturnType<typeof setInterval> | undefined;
	const HX_RETRY_MS = 20_000;
	/** Remembered deletes (message, conversation, contact), see sync.ts. */
	let tombs: Tomb[] = [];

	// Not reactive: connections and keys.
	let relay: RelayClient | null = null;
	let deviceRelay: RelayClient | null = null;
	let device: Identity | null = null;
	let sync: Uint8Array | null = null;
	let linkMailbox: Identity | null = null;
	let linkTimer: ReturnType<typeof setTimeout> | undefined;
	let outboxTimer: ReturnType<typeof setInterval> | undefined;
	const outbox: { to: string; id: string; body: string }[] = [];
	/** Delivery acks waiting to be sent (batched ~1 s): peer -> message ids. */
	const ackQueue = new Map<string, Set<string>>();
	let ackTimer: ReturnType<typeof setTimeout> | undefined;
	const ACK_MS = 1000;

	const activeContact = $derived(contacts.find((c) => c.address === active) ?? null);
	/** Safety number with the open contact; the same digits show on the contact's device. */
	const activeSafety = $derived(
		identity && activeContact ? safetyNumber(identity.address, activeContact.address) : ''
	);
	const activeMessages = $derived(active ? (chats[active] ?? []) : []);
	const myName = $derived(profile.name.trim().replace(/\s+/g, ' ').slice(0, 40));
	/** The name sent along with messages, or undefined when the user stays anonymous. */
	const sharedName = $derived(profile.share && myName ? myName : undefined);

	const relayUrl = () => platform.relayUrl();

	/**
	 * A link like /app/#to=<address>&name=<label> opens a conversation with that address.
	 * The part after # stays in the browser: neither the relay nor a proxy in between sees
	 * whom the visitor wants to reach.
	 */
	let invite: { address: string; name: string } | null = null;
	function readInvite(): void {
		const params = new URLSearchParams(location.hash.slice(1));
		if (params.has('link')) return readLinkCode(params.get('link') ?? '');
		const address = (params.get('to') ?? '').trim().toLowerCase();
		if (!isAddress(address)) return;
		invite = { address, name: (params.get('name') ?? '').trim().slice(0, 40) };
		history.replaceState(null, '', location.pathname + location.search);
	}
	/**
	 * A link like /app/#link=<code> (from the QR code of "Add a device") opens the "Link this
	 * device" screen with the code filled in. It does not start linking by itself: a link
	 * received from someone else would otherwise move a fresh device into that person's account.
	 * One tap on "Link" confirms that the code comes from the user's own device.
	 */
	let startNotice = '';
	function readLinkCode(raw: string): void {
		history.replaceState(null, '', location.pathname + location.search);
		const code = normalizeLinkCode(raw);
		if (!code) return void (startNotice = t('link_fail'));
		if (loadIdentity()) return void (startNotice = t('link_have_account'));
		onboard = 'link';
		codeInput = formatLinkCode(code);
	}
	function applyInvite(): void {
		if (!invite || !identity) return;
		newAddress = invite.address;
		newName = invite.name;
		invite = null;
		addContact();
	}
	const quiet: RelayEvents = {
		onStatus() {},
		onReady() {},
		onMessage: () => true,
		onSent() {},
		onError() {}
	};

	onMount(() => {
		let closed = false;
		// Contacts and chats come from IndexedDB; the UI stays hidden (ready = false) until they are in.
		void loadData().then((data) => {
			if (closed) return;
			contacts = data.contacts;
			chats = data.chats;
			blocked = data.blocked;
			receipts = loadReceipts();
			liveOn = loadLive();
			unread = data.unread;
			muted = data.muted;
			tombs = data.tombs;
			hx = data.hx;
			notifyMode = loadNotifyMode();
			bannerDismissed = loadNotifyBannerDismissed();
			void refreshPermission();
			begin();
		});
		baseTitle = document.title || 'MIGA';
		const onVisible = () => {
			visible = document.visibilityState === 'visible';
			if (visible) void refreshPermission();
		};
		onVisible();
		document.addEventListener('visibilitychange', onVisible);
		// Do not lose batched acks when the tab goes away.
		const onHide = () => flushAcks();
		window.addEventListener('pagehide', onHide);
		return () => {
			document.title = baseTitle;
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('pagehide', onHide);
			clearTimeout(ackTimer);
			closed = true;
			relay?.close();
			deviceRelay?.close();
			clearInterval(outboxTimer);
			clearTimeout(linkTimer);
			clearInterval(hxTimer);
			clearTimeout(hxFlashTimer);
		};
	});

	function begin(): void {
		profile = loadProfile();
		deviceLabel = guessDeviceLabel();
		readInvite();
		const me = loadIdentity();
		if (me) start(me);
		notice = startNotice;
		ready = true;
	}

	/** Opens two connections: one as the account, one as this device (for sync between devices). */
	function start(me: Identity): void {
		identity = me;
		revalidate(me.address);
		device = loadDevice();
		devices = loadDevices();
		sync = syncKey(me);

		relay = new RelayClient(relayUrl(), me, {
			onStatus: (s) => (status = s),
			onReady: () => {
				resendPending(me);
				flushAcks();
				checkSeen();
			},
			onLive: (f) => {
				// Receiving does not depend on my own setting: the sender chooses. Only the open chat shows it.
				if (blocked.includes(f.from) || f.from !== active) return;
				const plain = decrypt(me, f.from, f.body);
				if (!plain || plain.live === undefined) return;
				clearTimeout(liveInTimer);
				if (!plain.live) {
					liveIn = null;
					return;
				}
				liveIn = { peer: f.from, text: plain.live };
				liveInTimer = setTimeout(() => (liveIn = null), 5000);
				void tick().then(() => {
					const el = scroller;
					if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
				});
			},
			onMessage: (m) => {
				// Blocked: acknowledged (the relay deletes it) and dropped without a trace.
				if (blocked.includes(m.from)) return true;
				const plain = decrypt(me, m.from, m.body);
				// Anything we cannot open is acknowledged too, so it does not clog the queue.
				if (!plain) return true;
				// Live typing is ephemeral; one that still came as a normal message (old relay) is dropped.
				if (plain.live !== undefined) return true;
				// A delete request: only messages that came from this very sender can go.
				if (plain.del) {
					const items = plain.del.map((id) => ({ id, mine: false }));
					const list = chats[m.from];
					if (list && removeMessages(list, items)) persist();
					const now = Date.now();
					rememberDeletes(items.map((i) => ({ c: m.from, s: 'm' as const, id: i.id, mine: false, ts: now })));
					return true;
				}
				// An edit: only applied to a message THIS sender wrote (their own chat list, mine: false).
				// Never a bubble, never unread, never a notification, never acknowledged as a message.
				if (plain.edit) {
					const list = chats[m.from];
					const ts = editTime(plain.ts);
					if (list && applyEdit(list, { ...plain.edit, mine: false, ts })) {
						persist();
						syncAll({ k: 'edit', peer: m.from, id: plain.edit.id, mine: false, text: plain.edit.text, ts });
					}
					return true;
				}
				// Receipts: control messages, never a bubble, never acknowledged themselves.
				if (plain.ack || plain.seen) {
					if (plain.ack) applyStatus(m.from, plain.ack, 'delivered', true);
					// Like Signal: with read receipts off I do not show anyone else's either.
					if (plain.seen && receipts) applyStatus(m.from, plain.seen, 'read', true);
					return true;
				}
				// Deleted earlier (a re-delivery after "delete for me", or a conversation that was cleared): acknowledged and dropped.
				if (tombFilter(tombs)(m.from, { id: m.id, mine: false, ts: m.ts })) return true;
				reviveContact(m.from, m.ts);
				// The real message replaces the live line (control messages such as receipts do not).
				if (liveIn?.peer === m.from) {
					clearTimeout(liveInTimer);
					liveIn = null;
				}
				// A shared name is only a label chosen by the sender; the address stays the identity.
				ensureContact(m.from, plain.name);
				const message: Message = {
					id: m.id,
					mine: false,
					text: plain.text.slice(0, MAX_TEXT),
					ts: m.ts,
					state: 'received',
					...(plain.reply ? { reply: plain.reply } : {}),
					...(plain.att ? { att: plain.att } : {})
				};
				// Every online device gets the message from the relay; offline ones get this copy.
				if (addMessages(m.from, [message])) {
					syncAll({ k: 'msg', peer: m.from, message, name: plain.name });
					noteIncoming(m.from, previewOf(message), true);
				}
				persist();
				// Stored: tell the sender (also for a re-delivery, in case the first ack was lost).
				queueAck(m.from, m.id);
				return true;
			},
			onSent: (id) => {
				const found = setMessageState(id, 'sent');
				if (found) syncAll({ k: 'msg', peer: found.peer, message: $state.snapshot(found.message) });
			},
			onError: (code, id) => {
				// An older relay does not know the `unsend` frame and answers bad_frame without an id.
				if (code === 'bad_frame' && !id) return;
				if (id) setMessageState(id, 'failed');
				notice = t('n_relay_rejected', { code });
			}
		});
		relay.connect();

		deviceRelay = new RelayClient(relayUrl(), device, {
			...quiet,
			onReady: () => hxRequest(),
			onMessage: onSyncMessage
		});
		deviceRelay.connect();
		outboxTimer = setInterval(pumpOutbox, OUTBOX_MS);
		hxTimer = setInterval(hxTick, 5000);
		applyInvite();

		// A code left open by an earlier visit can no longer be shown; delete its bundle now.
		const leftover = loadOpenLink();
		if (leftover) {
			linkMailbox = identityFromSecret(hexToBytes(leftover));
			endLink('');
		}
	}

	// ── Sync between the user's own devices ─────────────────────────────────────────────

	function pumpOutbox(): void {
		const next = outbox[0];
		if (next && deviceRelay?.send(next.to, next.id, next.body)) outbox.shift();
	}

	function syncSend(to: string, message: SyncMessage): void {
		if (!device || !sync) return;
		outbox.push({ to, id: randomId(), body: seal(sync, message, device.address + to) });
	}

	function syncAll(message: SyncMessage): void {
		for (const other of devices) syncSend(other.address, message);
	}

	/** A message from another device of this account. Only holders of the account key can make one. */
	function onSyncMessage(m: Incoming): boolean {
		if (!device || !sync) return false;
		const message = open<SyncMessage>(sync, m.body, m.from + device.address);
		if (!message) return true;

		switch (message.k) {
			case 'hello': {
				if (!devices.some((d) => d.address === m.from)) {
					devices.push(...cleanDevices([{ address: m.from, label: message.label }]));
					saveDevices($state.snapshot(devices));
				}
				// Only the device that showed the code sends the snapshot, so it arrives once.
				if (message.sponsor === device.address) {
					if (link) endLink(t('dev_linked'));
					pushSnapshot(m.from);
				}
				break;
			}
			case 'state': {
				if (message.profile) {
					profile = cleanProfile(message.profile);
					saveProfile($state.snapshot(profile));
				}
				for (const raw of message.contacts ?? []) {
					const contact = cleanContact(raw);
					if (!contact || contact.address === identity?.address) continue;
					// Deleted on another device after this was sent: stays deleted. Added again later: comes back.
					if (contactTombTs(tombs, contact.address) >= m.ts) continue;
					reviveContact(contact.address, m.ts);
					const known = contacts.find((c) => c.address === contact.address);
					// A synced verification counts only if it matches the number this device computes.
					const verified =
						identity && contact.verified === safetyNumber(identity.address, contact.address)
							? contact.verified
							: undefined;
					if (known) {
						Object.assign(known, { name: contact.name, custom: contact.custom });
						if (verified) Object.assign(known, { verified, keyChanged: undefined });
						else delete known.verified;
					} else contacts.push({ ...contact, verified });
				}
				if (message.blocked !== undefined) {
					blocked = cleanBlocked(message.blocked, identity?.address);
					saveBlocked($state.snapshot(blocked));
				}
				if (message.muted !== undefined) {
					muted = cleanBlocked(message.muted, identity?.address);
					saveMuted($state.snapshot(muted));
				}
				for (const other of cleanDevices(message.devices)) {
					if (other.address !== device.address && !devices.some((d) => d.address === other.address)) {
						devices.push(other);
					}
				}
				saveDevices($state.snapshot(devices));
				persist();
				break;
			}
			case 'history': {
				const deleted = tombFilter(tombs);
				for (const [peer, list] of Object.entries(message.chats ?? {})) {
					if (!isAddress(peer) || !Array.isArray(list)) continue;
					const clean = list
						.map((x) => cleanMessage(x, MAX_TEXT))
						.filter((x): x is Message => x !== null && !deleted(peer, x));
					if (!clean.length) continue;
					ensureContact(peer);
					addMessages(peer, clean);
				}
				persist();
				break;
			}
			case 'hxq': {
				if (!ID_RE.test(message.sid ?? '') || !ID_RE.test(message.q ?? '')) break;
				const after = message.after === null ? null : cleanCursor(message.after);
				if (message.after !== null && !after) break;
				// A fresh copy starts with what was deleted, so nothing deleted is sent as history.
				if (after === null) {
					for (let i = 0; i < tombs.length; i += 100) {
						syncSend(m.from, { k: 'tomb', items: tombs.slice(i, i + 100) });
					}
				}
				const snap = $state.snapshot(chats);
				const page = historyPage(snap, after);
				syncSend(m.from, { k: 'hx', sid: message.sid, q: message.q, chats: page.chats, next: page.next, total: countMessages(snap) });
				break;
			}
			case 'hx': {
				if (!hx || message.sid !== hx.sid || !hxPending || message.q !== hxPending.q) break;
				hxPending = null;
				hxTry = 0;
				const deleted = tombFilter(tombs);
				let seen = 0;
				for (const [peer, list] of Object.entries(message.chats ?? {})) {
					if (!isAddress(peer) || !Array.isArray(list)) continue;
					seen += list.length;
					const clean = list
						.map((x) => cleanMessage(x, MAX_TEXT))
						.filter((x): x is Message => x !== null && !deleted(peer, x))
						// Old incoming messages are already read somewhere: no receipts, no unread, no notification.
						.map((x) => (x.mine ? x : { ...x, seen: true }));
					if (!clean.length) continue;
					ensureContact(peer);
					addMessages(peer, clean);
				}
				const next = message.next === null ? null : cleanCursor(message.next);
				persist();
				if (message.next === null || !next) {
					hx = null;
					saveHx(null);
					hxFlash = true;
					clearTimeout(hxFlashTimer);
					hxFlashTimer = setTimeout(() => (hxFlash = false), 4000);
				} else {
					hx = { ...hx, cursor: next, done: hx.done + seen, total: Math.max(Number(message.total) || 0, hx.total) };
					saveHx($state.snapshot(hx));
					hxRequest();
				}
				break;
			}
			case 'tomb': {
				applyRemoteTombs(message.items);
				break;
			}
			case 'read': {
				if (!isAddress(message.peer) || !Number.isFinite(Number(message.upTo))) break;
				const upTo = Number(message.upTo);
				const list = chats[message.peer] ?? [];
				let newer = 0;
				for (const x of list) {
					if (x.mine) continue;
					if (x.ts <= upTo) x.seen = true;
					else newer++;
				}
				if ((unread[message.peer] ?? 0) > newer) {
					if (newer) unread[message.peer] = newer;
					else delete unread[message.peer];
					saveUnread($state.snapshot(unread));
					if (!newer) platform.notifier.close('chat-' + message.peer);
				}
				persist();
				break;
			}
			case 'msg': {
				const clean = cleanMessage(message.message, MAX_TEXT);
				if (!clean || !isAddress(message.peer)) break;
				if (tombFilter(tombs)(message.peer, clean)) break;
				reviveContact(message.peer, clean.ts);
				ensureContact(message.peer, clean.mine ? undefined : message.name);
				// A copy from another device (it was offline when this arrived): counted, never notified.
				if (addMessages(message.peer, [clean]) && !clean.mine) noteIncoming(message.peer, previewOf(clean), false);
				persist();
				break;
			}
			case 'del': {
				if (!isAddress(message.peer)) break;
				// Older devices send `del`: remembered like a tombstone.
				const items = cleanDeleteItems(message.items);
				applyRemoteTombs(items.map((i) => ({ c: message.peer, s: 'm' as const, id: i.id, mine: i.mine, ts: m.ts })));
				break;
			}
			case 'edit': {
				if (!isAddress(message.peer) || typeof message.mine !== 'boolean') break;
				const list = chats[message.peer];
				if (list && applyEdit(list, { id: message.id, mine: message.mine, text: message.text, ts: message.ts })) persist();
				break;
			}
			case 'st': {
				if (!isAddress(message.peer) || (message.d !== 'delivered' && message.d !== 'read')) break;
				if (message.d === 'read' && !receipts) break;
				applyStatus(message.peer, cleanIds(message.ids), message.d, false);
				break;
			}
			case 'receipts': {
				receipts = message.on === true;
				saveReceipts(receipts);
				if (receipts) checkSeen();
				break;
			}
			case 'bye': {
				if (message.address === device.address) {
					// Another device removed this one: leave no trace here. The short delay lets the
					// acknowledgement reach the relay, so the notice is not kept there.
					setTimeout(() => {
						void eraseAll().then(() => location.reload());
					}, 300);
					return true;
				}
				devices = devices.filter((d) => d.address !== message.address);
				saveDevices($state.snapshot(devices));
				break;
			}
		}
		return true;
	}

	/** Brings a newly linked device up to date: profile, contacts, device list, recent history. */
	function pushSnapshot(to: string): void {
		if (!device) return;
		const all = $state.snapshot(contacts);
		const everyone: Device[] = [
			{ address: device.address, label: deviceLabel, added: Date.now() },
			...$state.snapshot(devices).filter((d) => d.address !== to)
		];
		syncSend(to, { k: 'state', profile: $state.snapshot(profile), devices: everyone });
		syncSend(to, { k: 'state', blocked: $state.snapshot(blocked) });
		syncSend(to, { k: 'state', muted: $state.snapshot(muted) });
		syncSend(to, { k: 'receipts', on: receipts });
		for (let i = 0; i < all.length; i += 50) {
			syncSend(to, { k: 'state', contacts: all.slice(i, i + 50) });
		}
		// The history itself is pulled page by page by the new device (see 'hxq'), so it can resume.
	}

	// ── Full history transfer (new device side) and tombstones ──────────────────────────

	const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

	/** Asks a device for the next page of history. One request is open at a time. */
	function hxRequest(): void {
		if (!hx || !device || !sync) return;
		const others = [hx.from, ...devices.map((d) => d.address).filter((a) => a !== hx!.from)];
		// Silent for three tries: the next device is asked (the first one may be gone).
		const to = others[Math.floor(hxTry / 3) % others.length];
		hxPending = { q: randomId(), at: Date.now() };
		syncSend(to, { k: 'hxq', sid: hx.sid, q: hxPending.q, after: hx.cursor });
	}

	function hxTick(): void {
		if (!hx) return;
		if (!hxPending) return hxRequest();
		if (Date.now() - hxPending.at > HX_RETRY_MS) {
			hxTry++;
			hxRequest();
		}
	}

	/** Copies all history again from another device (merge only: nothing deleted comes back). */
	function copyHistoryFrom(address: string): void {
		if (hx) return;
		hx = { sid: randomId(), from: address, cursor: null, done: 0, total: 0 };
		saveHx($state.snapshot(hx));
		hxTry = 0;
		hxRequest();
	}

	/** Records deletes made here and tells the other devices. */
	function rememberDeletes(items: Tomb[]): void {
		const added = addTombs(tombs, items);
		if (!added.length) return;
		saveTombs([...tombs]);
		for (let i = 0; i < added.length; i += 100) syncAll({ k: 'tomb', items: added.slice(i, i + 100) });
	}

	/** Deletes announced by another device: remembered and applied here. */
	function applyRemoteTombs(raw: unknown): void {
		const added = addTombs(tombs, cleanTombs(raw));
		if (!added.length) return;
		saveTombs([...tombs]);
		const result = applyTombs(added, chats, contacts);
		for (const t of added) if (t.s !== 'm') clearUnread(t.c);
		if (active && result.goneContacts.includes(active)) active = null;
		persist();
	}

	/** A contact that was deleted comes back when it is added again or writes after the delete. */
	function reviveContact(address: string, ts: number): void {
		const at = contactTombTs(tombs, address);
		if (at && ts > at && clearContactTomb(tombs, address)) saveTombs([...tombs]);
	}

	// ── Adding a device (shown on a device that already has the account) ───────────────

	async function addDevice(): Promise<void> {
		if (!identity || !device) return;
		if (status !== 'online') {
			linkNotice = t('link_no_relay');
			return;
		}
		const code = newLinkCode();
		const expires = Date.now() + LINK_TTL_MS;
		link = { code };
		linkNotice = '';
		const { identity: mailbox, key } = await deriveLink(code);
		if (link?.code !== code) return; // cancelled while the key was being derived

		linkMailbox = mailbox;
		saveOpenLink(bytesToHex(mailbox.secret));
		const bundle: LinkBundle = {
			k: 'link',
			secret: bytesToHex(identity.secret),
			sponsor: device.address,
			exp: expires,
			profile: $state.snapshot(profile),
			devices: [
				{ address: device.address, label: deviceLabel, added: Date.now() },
				...$state.snapshot(devices)
			]
		};
		// The bundle waits on the relay under an address only the code can derive.
		outbox.push({ to: mailbox.address, id: randomId(), body: seal(key, bundle) });
		linkTimer = setTimeout(() => endLink(t('dev_expired')), LINK_TTL_MS);
	}

	/** Closes the code and makes sure no copy of the bundle is left waiting on the relay. */
	function endLink(message: string): void {
		clearTimeout(linkTimer);
		if (linkMailbox) {
			const sweeper = new RelayClient(relayUrl(), linkMailbox, quiet);
			sweeper.connect();
			setTimeout(() => sweeper.close(), 8000);
		}
		linkMailbox = null;
		saveOpenLink(null);
		link = null;
		linkNotice = message;
	}

	async function removeDevice(address: string): Promise<void> {
		if (!(await ask({ body: t('q_dev_remove'), confirm: t('dev_remove'), danger: true }))) return;
		// The removed device is told too: it erases itself the next time it connects.
		syncAll({ k: 'bye', address });
		linkNotice = '';
		devices = devices.filter((d) => d.address !== address);
		saveDevices($state.snapshot(devices));
	}

	async function eraseThisDevice(): Promise<void> {
		if (!(await ask({ body: t('q_erase'), confirm: t('erase'), danger: true }))) return;
		if (linkMailbox) endLink('');
		if (device && sync) {
			for (const other of devices) {
				const body = seal(sync, { k: 'bye', address: device.address }, device.address + other.address);
				deviceRelay?.send(other.address, randomId(), body);
			}
		}
		// Give the goodbye a moment to leave before the keys are gone.
		setTimeout(() => void eraseAll().then(() => location.reload()), 400);
	}

	// ── First run ───────────────────────────────────────────────────────────────────────

	function createAddress(event: SubmitEvent): void {
		event.preventDefault();
		saveProfile($state.snapshot(profile));
		notice = '';
		start(createIdentity());
	}

	/** On the new device: fetch the bundle that the code points to and adopt the account. */
	async function linkThisDevice(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const code = normalizeLinkCode(codeInput);
		if (!code) {
			notice = t('link_fail');
			return;
		}
		linking = true;
		notice = '';
		const { identity: mailbox, key } = await deriveLink(code);
		let done = false;
		let connected = false;

		const client = new RelayClient(relayUrl(), mailbox, {
			...quiet,
			onReady: () => (connected = true),
			onMessage: (m) => {
				if (done) return false;
				const bundle = open<LinkBundle>(key, m.body);
				const valid =
					bundle?.k === 'link' &&
					typeof bundle.secret === 'string' &&
					/^[0-9a-f]{64}$/.test(bundle.secret) &&
					typeof bundle.sponsor === 'string' &&
					Number(bundle.exp) > Date.now();
				// Stale or foreign content is acknowledged so it is deleted from the relay.
				if (!bundle || !valid) return true;

				done = true;
				const me = identityFromSecret(hexToBytes(bundle.secret));
				saveIdentity(me);
				profile = cleanProfile(bundle.profile);
				saveProfile($state.snapshot(profile));
				const mine = loadDevice();
				saveDevices(cleanDevices(bundle.devices).filter((d) => d.address !== mine.address));
				// Runs after the acknowledgement has been written to the socket.
				setTimeout(() => {
					client.close();
					linking = false;
					codeInput = '';
					start(me);
					syncAll({ k: 'hello', label: deviceLabel, sponsor: bundle.sponsor });
					if (isAddress(bundle.sponsor)) {
						// The history is copied from the device that showed the code, page by page.
						hx = { sid: randomId(), from: bundle.sponsor, cursor: null, done: 0, total: 0 };
						saveHx($state.snapshot(hx));
						hxTry = 0;
						hxRequest();
					}
				}, 0);
				return true;
			}
		});
		client.connect();
		// Linking only works through the relay: say so plainly when there is no connection to it.
		setTimeout(() => {
			if (done || connected) return;
			done = true;
			client.close();
			linking = false;
			notice = t('link_no_relay');
		}, LINK_CONNECT_MS);
		setTimeout(() => {
			if (done) return;
			done = true;
			client.close();
			linking = false;
			notice = t('link_fail');
		}, LINK_WAIT_MS);
	}

	// ── Chats ───────────────────────────────────────────────────────────────────────────

	$effect(() => {
		void activeMessages.length;
		void uploads.length;
		void active;
		scroller?.scrollTo(0, scroller.scrollHeight);
	});

	// ── Receipts ────────────────────────────────────────────────────────────────────────

	const RANK = { delivered: 1, read: 2 } as const;

	/** Marks my messages as delivered/read. Never goes backwards. Forwards changes to my other devices. */
	function applyStatus(peer: string, ids: string[], d: 'delivered' | 'read', forward: boolean): void {
		const list = chats[peer];
		if (!list) return;
		const wanted = new Set(ids);
		const changed: string[] = [];
		for (const m of list) {
			if (!m.mine || !wanted.has(m.id)) continue;
			if ((m.delivery ? RANK[m.delivery] : 0) >= RANK[d]) continue;
			m.delivery = d;
			if (m.state === 'pending') m.state = 'sent';
			changed.push(m.id);
		}
		if (!changed.length) return;
		persist();
		if (forward) syncAll({ k: 'st', peer, ids: changed, d });
	}

	function queueAck(peer: string, id: string): void {
		let set = ackQueue.get(peer);
		if (!set) ackQueue.set(peer, (set = new Set()));
		set.add(id);
		clearTimeout(ackTimer);
		ackTimer = setTimeout(flushAcks, ACK_MS);
	}

	/** Sends the batched delivery acks. What cannot be sent now (offline) stays queued for onReady. */
	function flushAcks(): void {
		clearTimeout(ackTimer);
		if (!identity || !relay) return;
		for (const [peer, set] of ackQueue) {
			const all = [...set];
			for (let i = 0; i < all.length; i += MAX_DELETE) {
				const chunk = all.slice(i, i + MAX_DELETE);
				if (!relay.send(peer, randomId(), encryptReceipt(identity, peer, 'ack', chunk))) return;
				for (const id of chunk) set.delete(id);
			}
			if (!set.size) ackQueue.delete(peer);
		}
	}

	function nearBottom(): boolean {
		return !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
	}

	/**
	 * The open chat is visible and scrolled to the end: its incoming messages count as read. With
	 * read receipts off they are only marked locally; nothing is sent.
	 */
	function checkSeen(): void {
		if (!active || view !== 'chat' || !visible || !ready || !nearBottom()) return;
		const peer = active;
		const list = chats[peer];
		if (!list) return;
		const todo = list.filter((m) => !m.mine && !m.seen);
		if (!todo.length) return;
		if (!receipts || blocked.includes(peer)) {
			for (const m of todo) m.seen = true;
			persist();
			return;
		}
		if (!identity || !relay) return;
		for (let i = 0; i < todo.length; i += MAX_DELETE) {
			const chunk = todo.slice(i, i + MAX_DELETE);
			if (!relay.send(peer, randomId(), encryptReceipt(identity, peer, 'seen', chunk.map((m) => m.id)))) return;
			for (const m of chunk) m.seen = true;
			persist();
		}
	}

	$effect(() => {
		void active;
		void activeMessages.length;
		void uploads.length;
		void visible;
		void view;
		void receipts;
		void tick().then(checkSeen);
	});

	function setLive(on: boolean): void {
		liveOn = on;
		saveLive(on);
	}

	// ── Live typing (sender side) ───────────────────────────────────────────────────────
	let livePeer: string | null = null;
	let liveLast = '';
	let liveLatest = '';
	let liveTimer: ReturnType<typeof setTimeout> | undefined;

	function liveFlush(): void {
		liveTimer = undefined;
		if (!livePeer || !identity || liveLatest === liveLast) return;
		if (relay?.sendLive(livePeer, encryptLive(identity, livePeer, liveLatest))) liveLast = liveLatest;
	}

	/** peer = null: nothing may be sent right now (setting off, no focus, other chat ...). */
	function liveUpdate(peer: string | null, text: string): void {
		if (livePeer && livePeer !== peer) {
			// Chat switch, blur or setting off: clear what the other side still sees.
			clearTimeout(liveTimer);
			liveTimer = undefined;
			if (liveLast && identity) relay?.sendLive(livePeer, encryptLive(identity, livePeer, ''));
			liveLast = '';
		}
		livePeer = peer;
		if (!peer) return;
		liveLatest = text;
		if (!text) {
			clearTimeout(liveTimer);
			liveTimer = undefined;
			if (liveLast) liveFlush();
		} else if (text !== liveLast && liveTimer === undefined) {
			liveTimer = setTimeout(liveFlush, 300); // throttled, trailing edge
		}
	}

	$effect(() => {
		const peer =
			liveOn && composerFocused && visible && view === 'chat' && !editing && active && !blocked.includes(active)
				? active
				: null;
		const text = draft.slice(0, MAX_TEXT);
		untrack(() => liveUpdate(peer, text));
	});

	// A live line belongs to the chat that is open.
	$effect(() => {
		if (liveIn && liveIn.peer !== active) {
			clearTimeout(liveInTimer);
			liveIn = null;
		}
	});

	function setReceipts(on: boolean): void {
		receipts = on;
		saveReceipts(on);
		syncAll({ k: 'receipts', on });
		if (on) checkSeen();
	}

	// ── Unread counters and notifications ───────────────────────────────────────────────

	let baseTitle = 'MIGA';
	/** Muted chats are left out of the title: they count in the list but must not nag. */
	const unreadTotal = $derived(
		Object.entries(unread).reduce((sum, [peer, n]) => (muted.includes(peer) ? sum : sum + n), 0)
	);

	$effect(() => {
		document.title = unreadTotal > 0 ? `(${unreadTotal > 99 ? '99+' : unreadTotal}) ${baseTitle}` : baseTitle;
	});

	/** The open chat is on screen: its incoming messages are read as they arrive. */
	function chatInView(peer: string): boolean {
		return view === 'chat' && active === peer && visible;
	}

	/** A new incoming text message: count it unless the chat is being read, and notify unless muted. */
	function noteIncoming(peer: string, text: string, notify: boolean): void {
		const reading = chatInView(peer);
		if (!reading) {
			unread[peer] = (unread[peer] ?? 0) + 1;
			saveUnread($state.snapshot(unread));
		} else if (notify) {
			// Read right here as it arrived: my other devices must not count it as unread.
			sendRead(peer);
		}
		if (!notify || muted.includes(peer) || blocked.includes(peer)) return;
		// Reading with the window in front of the user: no alert.
		if (reading && document.hasFocus()) return;
		const name = contacts.find((c) => c.address === peer)?.name ?? shortAddress(peer);
		const generic = t('notif_new_message');
		platform.notifier.show({
			tag: 'chat-' + peer,
			title: notifyMode === 'generic' ? 'MIGA' : name,
			body: notifyMode === 'full' ? text.slice(0, 140) : generic,
			onClick: () => {
				window.focus();
				openChat(peer);
			}
		});
	}

	// Opening a chat that is on screen clears its counter and removes its notification.
	$effect(() => {
		if (!active || view !== 'chat' || !visible || !unread[active]) return;
		const peer = active;
		delete unread[peer];
		saveUnread($state.snapshot(unread));
		platform.notifier.close('chat-' + peer);
		sendRead(peer);
	});

	/** Tells my other devices this chat is read up to its newest incoming message. */
	function sendRead(peer: string): void {
		let upTo = 0;
		for (const x of chats[peer] ?? []) if (!x.mine && x.ts > upTo) upTo = x.ts;
		if (upTo) syncAll({ k: 'read', peer, upTo });
	}

	async function refreshPermission(): Promise<void> {
		notifyPerm = await platform.notifier.permission();
	}

	/** Called from a click only: the browser may refuse a prompt that was not asked for by the user. */
	async function enableNotifications(): Promise<void> {
		notifyPerm = await platform.notifier.request();
	}

	function dismissBanner(): void {
		bannerDismissed = true;
		saveNotifyBannerDismissed();
	}

	function setNotifyMode(mode: NotifyMode): void {
		notifyMode = mode;
		saveNotifyMode(mode);
	}

	function toggleMute(address: string): void {
		menuOpen = false;
		ctx = null;
		muted = muted.includes(address) ? muted.filter((a) => a !== address) : [...muted, address].slice(0, MAX_BLOCKED);
		saveMuted($state.snapshot(muted));
		syncAll({ k: 'state', muted: $state.snapshot(muted) });
	}

	function persist(): void {
		saveContacts($state.snapshot(contacts));
		saveChats($state.snapshot(chats));
		scheduleMediaGc();
	}

	/** Local media of messages that are gone (deleted, chat erased) is removed shortly after. */
	let gcTimer: ReturnType<typeof setTimeout> | undefined;
	function scheduleMediaGc(): void {
		clearTimeout(gcTimer);
		gcTimer = setTimeout(async () => {
			const used = new Set<string>();
			for (const list of Object.values(chats)) for (const m of list) if (m.att) used.add(m.att.blob);
			const stale = (await mediaIds()).filter((id) => !used.has(id));
			if (stale.length) await deleteMedia(stale);
		}, 800);
	}

	/** What a chat list row, a reply quote or a notification shows for a message. */
	const previewOf = (m: Message): string => m.text || (m.att ? t('att_photo') : '');

	function ensureContact(address: string, name?: string): void {
		const clean = name?.trim().replace(/\s+/g, ' ').slice(0, 40);
		const known = contacts.find((c) => c.address === address);
		if (!known) {
			contacts.push({ address, name: clean || t('name_unknown') + ' ' + address.slice(0, 6) });
		} else if (!known.custom && clean) {
			known.name = clean;
		}
	}

	function addMessages(peer: string, incoming: Message[]): boolean {
		if (!chats[peer]) chats[peer] = [];
		return mergeMessages(chats[peer], incoming);
	}

	function setMessageState(
		id: string,
		state: Message['state']
	): { peer: string; message: Message } | null {
		for (const [peer, list] of Object.entries(chats)) {
			const found = list.find((m) => m.mine && m.id === id);
			if (found) {
				found.state = state;
				persist();
				return { peer, message: found };
			}
		}
		return null;
	}

	function resendPending(me: Identity): void {
		for (const [address, list] of Object.entries(chats)) {
			for (const m of list) {
				if (m.mine && m.state === 'pending') {
					relay?.send(address, m.id, encrypt(me, address, m.text, sharedName, m.reply, m.att));
				}
			}
		}
	}

	function startEdit(message: Message): void {
		msgMenu = null;
		if (!active || !message.mine || message.state !== 'sent') return;
		replyTo = null;
		emojiOpen = false;
		gifOpen = false;
		editing = { peer: active, id: message.id, text: message.text };
		draft = message.text;
		tick().then(() => composerInput?.focus());
	}

	function cancelEdit(): void {
		if (!editing) return;
		editing = null;
		draft = '';
	}

	function saveEdit(text: string): void {
		const edit = editing;
		if (!edit || !identity) return;
		const message = chats[edit.peer]?.find((m) => m.mine && m.id === edit.id);
		if (!message) return cancelEdit(); // deleted meanwhile
		if (!text) {
			notice = t('n_edit_empty');
			return;
		}
		if (text.length > MAX_TEXT) {
			notice = t('n_too_long', { max: MAX_TEXT });
			return;
		}
		if (text === message.text) return cancelEdit();
		const ts = Math.max(Date.now(), (message.edited ?? 0) + 1);
		// Like "delete for everyone": nothing changes anywhere unless the request could be sent.
		if (!relay?.send(edit.peer, randomId(), encryptEdit(identity, edit.peer, edit.id, text, ts))) {
			notice = t('n_edit_offline');
			return;
		}
		if (applyEdit(chats[edit.peer], { id: edit.id, mine: true, text, ts })) persist();
		syncAll({ k: 'edit', peer: edit.peer, id: edit.id, mine: true, text, ts });
		editing = null;
		draft = '';
	}

	async function toggleEmoji(): Promise<void> {
		if (emojiOpen) return closeEmoji();
		if (!EmojiPicker) {
			try {
				EmojiPicker = (await import('./EmojiPicker.svelte')).default;
			} catch {
				return;
			}
		}
		gifOpen = false;
		emojiOpen = true;
	}

	async function toggleGif(): Promise<void> {
		if (gifOpen) return closeGif();
		if (!GifPanel) {
			try {
				GifPanel = (await import('./GifPanel.svelte')).default;
			} catch {
				return;
			}
		}
		emojiOpen = false;
		gifOpen = true;
	}

	function closeGif(): void {
		if (!gifOpen) return;
		gifOpen = false;
		composerInput?.focus();
	}

	/** One tap in the GIF panel: the file goes through the normal encrypted attachment path. */
	function sendGif(file: File): void {
		gifOpen = false;
		void attachFiles([file]);
	}

	function showGifNotice(text: string): void {
		attError = text;
		clearTimeout(attErrorTimer);
		attErrorTimer = setTimeout(() => (attError = ''), 9000);
	}

	function closeEmoji(): void {
		if (!emojiOpen) return;
		emojiOpen = false;
		composerInput?.focus();
	}

	/** Inserts at the caret (or replaces the selection) of the composer. */
	function insertEmoji(emoji: string): void {
		const input = composerInput;
		const from = input?.selectionStart ?? draft.length;
		const to = input?.selectionEnd ?? draft.length;
		if (draft.length - (to - from) + emoji.length > MAX_TEXT) return;
		draft = draft.slice(0, from) + emoji + draft.slice(to);
		const caret = from + emoji.length;
		tick().then(() => input?.setSelectionRange(caret, caret));
	}

	/** Escape closes the innermost thing first: picker, then edit or reply, menus always. */
	function onEscape(): void {
		menuOpen = false;
		ctx = null;
		msgMenu = null;
		if (emojiOpen) return closeEmoji();
		if (gifOpen) return closeGif();
		if (editing) return cancelEdit();
		replyTo = null;
	}

	/** Grows the composer with its text, up to a few lines, then it scrolls. */
	function growComposer(): void {
		const el = composerInput;
		if (!el) return;
		el.style.height = 'auto';
		const max = 6 * 24;
		el.style.height = Math.min(el.scrollHeight, max) + 'px';
		el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
	}
	// An emptied or replaced draft (send, edit, emoji) must shrink the box again.
	$effect(() => {
		void draft;
		tick().then(growComposer);
	});

	/** Enter sends, Shift+Enter starts a new line. A key press that only confirms an IME candidate is left alone. */
	function onComposerKey(e: KeyboardEvent): void {
		if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
		e.preventDefault();
		(e.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
	}

	/** Enter in a single-line field: move on or run the action (some on-screen keyboards do not submit forms by themselves). */
	function onEnter(e: KeyboardEvent, action: () => void): void {
		if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
		e.preventDefault();
		action();
	}

	function sendMessage(event: SubmitEvent): void {
		event.preventDefault();
		const text = draft.trim();
		if (editing) return saveEdit(text);
		if (!text || !active || !identity) return;
		if (text.length > MAX_TEXT) {
			notice = t('n_too_long', { max: MAX_TEXT });
			return;
		}
		const id = randomId();
		if (!chats[active]) chats[active] = [];
		const reply = replyTo ?? undefined;
		chats[active].push({
			id,
			mine: true,
			text,
			ts: Date.now(),
			state: 'pending',
			...(reply ? { reply } : {})
		});
		persist();
		draft = '';
		replyTo = null;
		// When offline it stays "pending" and is sent on the next connection.
		relay?.send(active, id, encrypt(identity, active, text, sharedName, reply));
	}

	// ── Attachments ─────────────────────────────────────────────────────────────────────

	function showAttError(code: string): void {
		const known = ['too_big', 'unsupported', 'decode', 'quota', 'rate', 'network'];
		attError = t(known.includes(code) ? (`att_${code}` as 'att_network') : 'att_failed');
		clearTimeout(attErrorTimer);
		attErrorTimer = setTimeout(() => (attError = ''), 9000);
	}

	function pickFiles(): void {
		fileInput?.click();
	}

	/** Called for the file picker, a paste and a drop. The composer text becomes the caption. */
	async function attachFiles(files: Iterable<File>): Promise<void> {
		const peer = active;
		if (!peer || !identity || blocked.includes(peer)) return;
		for (const file of files) {
			if (file.size > MAX_ATTACHMENT) {
				showAttError('too_big');
				continue;
			}
			const caption = draft.trim().slice(0, MAX_TEXT);
			const reply = replyTo ?? undefined;
			draft = '';
			replyTo = null;
			const item: UploadItem = { key: randomId(), peer, caption, ...(reply ? { reply } : {}), ts: Date.now(), state: 'preparing', progress: 0, error: '', thumb: '', w: 4, h: 3 };
			uploads.push(item);
			const mine = () => uploads.find((u) => u.key === item.key);
			try {
				const prepared = await prepare(file);
				const live = mine();
				if (!live) continue; // cancelled while preparing
				live.thumb = prepared.thumb;
				live.w = prepared.w;
				live.h = prepared.h;
				uploadData.set(item.key, { prepared });
				await sendUpload(item.key);
			} catch (e) {
				const code = e instanceof AttachError ? e.code : 'decode';
				uploads = uploads.filter((u) => u.key !== item.key);
				uploadData.delete(item.key);
				showAttError(code);
			}
		}
	}

	async function sendUpload(key: string): Promise<void> {
		const item = uploads.find((u) => u.key === key);
		const data = uploadData.get(key);
		if (!item || !data?.prepared || !identity) return;
		item.state = 'sending';
		item.progress = 0;
		item.error = '';
		const up = upload(data.prepared, (f) => {
			const live = uploads.find((u) => u.key === key);
			if (live) live.progress = f;
		}, data.sealed);
		data.sealed = up.sealed;
		data.cancel = up.cancel;
		let att: Att;
		try {
			att = await up.promise;
		} catch (e) {
			const code = e instanceof AttachError ? e.code : 'upload';
			const live = uploads.find((u) => u.key === key);
			if (code === 'cancelled' || !live) return;
			live.state = 'failed';
			live.error = code;
			showAttError(code);
			return;
		}
		const peer = item.peer;
		const id = randomId();
		if (!chats[peer]) chats[peer] = [];
		chats[peer].push({ id, mine: true, text: item.caption, ts: Date.now(), state: 'pending', att, ...(item.reply ? { reply: item.reply } : {}) });
		persist();
		// Our own copy of the file, so it shows at once and survives a reload.
		void saveMedia(att.blob, new Blob([data.prepared.bytes as BlobPart], { type: att.mime }), att.mime);
		uploads = uploads.filter((u) => u.key !== key);
		uploadData.delete(key);
		relay?.send(peer, id, encrypt(identity, peer, item.caption, sharedName, item.reply, att));
	}

	function cancelUpload(key: string): void {
		uploadData.get(key)?.cancel?.();
		uploads = uploads.filter((u) => u.key !== key);
		uploadData.delete(key);
	}

	function onPaste(e: ClipboardEvent): void {
		const files = [...(e.clipboardData?.files ?? [])];
		if (!files.length) return;
		e.preventDefault();
		void attachFiles(files);
	}

	function onDragOver(e: DragEvent): void {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		dragging = true;
	}

	function onDrop(e: DragEvent): void {
		if (!e.dataTransfer?.files.length) return;
		e.preventDefault();
		dragging = false;
		void attachFiles([...e.dataTransfer.files]);
	}

	function addContact(event?: SubmitEvent): void {
		event?.preventDefault();
		const address = newAddress.trim().toLowerCase();
		if (!isAddress(address)) {
			notice = t('n_bad_address');
			return;
		}
		if (address === identity?.address) {
			notice = t('n_own_address');
			return;
		}
		if (!contacts.some((c) => c.address === address)) {
			const typed = newName.trim();
			const contact: Contact = {
				address,
				name: typed || t('name_contact') + ' ' + address.slice(0, 6),
				custom: typed !== ''
			};
			reviveContact(address, Date.now());
			contacts.push(contact);
			persist();
			syncAll({ k: 'state', contacts: [contact] });
		}
		newAddress = '';
		newName = '';
		notice = '';
		view = 'chat';
		active = address;
	}

	function scanned(result: Scanned): void {
		const kind = scanning;
		scanning = null;
		if (result.kind === 'link' && kind === 'link') {
			codeInput = formatLinkCode(result.code);
		} else if (result.kind === 'to' && kind === 'to') {
			newAddress = result.address;
			newName = result.name;
		} else if (result.kind === 'verify' && kind === 'verify' && active) {
			if (result.number === activeSafety) {
				verifyResult = 'match';
				setVerified(active, true);
			} else {
				verifyResult = 'mismatch';
			}
		}
	}

	/** Link that opens the app and adds this account as a contact. The name goes along only if shared. */
	const inviteUrl = $derived(
		identity
			? appUrl(platform.publicOrigin(), { to: identity.address, ...(sharedName ? { name: sharedName } : {}) })
			: ''
	);

	function saveProfileForm(event: SubmitEvent): void {
		event.preventDefault();
		saveProfile($state.snapshot(profile));
		syncAll({ k: 'state', profile: $state.snapshot(profile) });
	}

	async function copyAddress(): Promise<void> {
		if (!identity) return;
		try {
			await navigator.clipboard.writeText(identity.address);
			notice = t('n_copied');
		} catch {
			notice = t('n_copy_failed');
		}
	}

	async function backupKey(): Promise<void> {
		if (!identity) return;
		if (!(await ask({ body: t('q_backup'), confirm: t('backup_key') }))) return;
		try {
			await navigator.clipboard.writeText(bytesToHex(identity.secret));
			notice = t('n_key_copied');
		} catch {
			notice = t('n_key_copy_failed');
		}
	}

	async function restoreKey(): Promise<void> {
		const typed = await askText({
			title: t('restore'),
			// One step: the warning is part of the same dialog, so no second dialog can swallow the click.
			body: identity ? `${t('q_restore_confirm')}\n\n${t('q_restore_prompt')}` : t('q_restore_prompt'),
			confirm: t('restore'),
			danger: identity !== null,
			placeholder: t('ph_key')
		});
		const value = typed?.trim().toLowerCase();
		if (!value) return;
		if (!/^[0-9a-f]{64}$/.test(value)) {
			notice = t('n_bad_key');
			return;
		}
		saveIdentity(identityFromSecret(hexToBytes(value)));
		// The device list belongs to the account that is being replaced.
		saveDevices([]);
		location.reload();
	}

	/**
	 * A verified contact whose stored number no longer matches the current keys (this account's key
	 * was replaced) loses the verification and gets a warning. A contact address never changes by
	 * itself, so this is the only way the keys behind a number can change.
	 */
	function revalidate(me: string): void {
		let changed = false;
		for (const c of contacts) {
			if (c.verified && c.verified !== safetyNumber(me, c.address)) {
				delete c.verified;
				c.keyChanged = true;
				changed = true;
			}
		}
		if (changed) saveContacts($state.snapshot(contacts));
	}

	function openVerify(address: string): void {
		ctx = null;
		openChat(address);
		view = 'verify';
		verifyResult = null;
		notice = '';
	}

	function setVerified(address: string, on: boolean): void {
		const contact = contacts.find((c) => c.address === address);
		if (!contact || !identity) return;
		if (on) contact.verified = safetyNumber(identity.address, address);
		else delete contact.verified;
		delete contact.keyChanged;
		saveContacts($state.snapshot(contacts));
		syncAll({ k: 'state', contacts: [$state.snapshot(contact)] });
	}

	function dismissChanged(address: string): void {
		const contact = contacts.find((c) => c.address === address);
		if (!contact) return;
		delete contact.keyChanged;
		saveContacts($state.snapshot(contacts));
	}

	async function copySafety(): Promise<void> {
		try {
			await navigator.clipboard.writeText(groupSafety(activeSafety));
			notice = t('safety_copied');
		} catch {
			notice = t('n_copy_failed');
		}
	}

	// ── Search (local only: decrypted messages already in memory, nothing is sent anywhere) ──

	const SEARCH_DEBOUNCE_MS = 150;
	let searchOpen = $state(false);
	let searchInput = $state('');
	/** Debounced copy of searchInput; matching uses this one. */
	let searchQuery = $state('');
	let searchCur = $state(0);
	let searchMs = $state(0);
	let searchField = $state<HTMLInputElement | null>(null);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	const searchHits = $derived.by(() => {
		if (!searchOpen || !searchQuery.trim()) return [];
		return searchMessages(activeMessages, searchQuery);
	});

	/** Runs one search and records how long it took (shown as data-ms on the bar, for tests). */
	function runSearch(text: string): number {
		const t0 = performance.now();
		const n = searchMessages(activeMessages, text).length;
		searchMs = Math.round((performance.now() - t0) * 10) / 10;
		return n;
	}
	const searchKeys = $derived(new Set(searchHits.map(messageKey)));
	const searchCurKey = $derived(searchHits[searchCur] ? messageKey(searchHits[searchCur]) : '');

	function onSearchInput(): void {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			searchQuery = searchInput;
			searchCur = Math.max(0, runSearch(searchInput) - 1);
			void scrollToCurrent();
		}, SEARCH_DEBOUNCE_MS);
	}

	function openSearch(): void {
		menuOpen = false;
		searchOpen = true;
		void tick().then(() => searchField?.focus());
	}

	function closeSearch(): void {
		clearTimeout(searchTimer);
		searchOpen = false;
		searchInput = '';
		searchQuery = '';
		searchCur = 0;
	}

	function stepSearch(delta: number): void {
		const n = searchHits.length;
		if (!n) return;
		searchCur = (searchCur + delta + n) % n;
		void scrollToCurrent();
	}

	async function scrollToCurrent(): Promise<void> {
		await tick();
		const key = searchCurKey;
		if (!key) return;
		const target = Array.from(scroller?.children ?? []).find((el) => (el as HTMLElement).dataset.key === key);
		target?.scrollIntoView({ block: 'center' });
	}

	function onSearchKey(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeSearch();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			clearTimeout(searchTimer);
			if (searchQuery !== searchInput) {
				searchQuery = searchInput;
				searchCur = Math.max(0, runSearch(searchInput) - 1);
			} else stepSearch(event.shiftKey ? -1 : 1);
			void scrollToCurrent();
		}
	}

	// The search belongs to one conversation: leaving it closes the bar.
	$effect(() => {
		void active;
		untrack(closeSearch);
	});

	// Search across all conversations (chat list header).
	let gOpen = $state(false);
	let gInput = $state('');
	let gQuery = $state('');
	let gTimer: ReturnType<typeof setTimeout> | undefined;
	let gFields = $state<HTMLInputElement[]>([]);
	const gResults = $derived(gQuery.trim() ? searchAll(chats, gQuery) : null);
	const nameOf = (address: string) => contacts.find((c) => c.address === address)?.name ?? shortAddress(address);

	function onGlobalInput(): void {
		clearTimeout(gTimer);
		gTimer = setTimeout(() => (gQuery = gInput), SEARCH_DEBOUNCE_MS);
	}

	function toggleGlobal(): void {
		if (gOpen) return closeGlobal();
		gOpen = true;
		void tick().then(() => gFields.find((f) => f && f.offsetParent)?.focus());
	}

	function closeGlobal(): void {
		clearTimeout(gTimer);
		gOpen = false;
		gInput = '';
		gQuery = '';
	}

	/** Opens the chat of a global hit and brings the message into view. */
	async function openHit(address: string, message: Message): Promise<void> {
		openChat(address);
		const key = messageKey(message);
		await tick();
		setTimeout(() => {
			const target = Array.from(scroller?.children ?? []).find((el) => (el as HTMLElement).dataset.key === key);
			if (!target) return;
			target.scrollIntoView({ block: 'center' });
			highlighted = key;
			setTimeout(() => highlighted === key && (highlighted = ''), 2000);
		}, 80);
	}

	function openChat(address: string): void {
		replyTo = null;
		editing = null;
		emojiOpen = false;
		gifOpen = false;
		view = 'chat';
		menuOpen = false;
		active = address;
	}

	function openMenu(event: MouseEvent, address: string): void {
		if (!isDesktop) return;
		event.preventDefault();
		menuOpen = false;
		// Keep the menu inside the window.
		ctx = {
			x: Math.min(event.clientX, window.innerWidth - 200),
			y: Math.min(event.clientY, window.innerHeight - 60),
			address
		};
	}

	function openNew(): void {
		view = 'new';
		menuOpen = false;
		notice = '';
	}

	/** Clears the messages of one conversation on this device only; the contact stays. */
	async function deleteConversation(address: string): Promise<void> {
		menuOpen = false;
		ctx = null;
		const contact = contacts.find((c) => c.address === address);
		if (!contact) return;
		const ok = await ask({
			body: t('q_delete_chat', { name: contact.name }),
			confirm: t('delete_chat'),
			danger: true
		});
		if (!ok) return;
		delete chats[address];
		clearUnread(address);
		rememberDeletes([{ c: address, s: 'c', ts: Date.now() }]);
		persist();
	}

	function clearUnread(address: string): void {
		if (!unread[address]) return;
		delete unread[address];
		saveUnread($state.snapshot(unread));
	}

	/** Blocks or unblocks an address, here and on the linked devices. A blocked address stays blocked after its contact is deleted. */
	async function toggleBlock(address: string): Promise<void> {
		menuOpen = false;
		ctx = null;
		const contact = contacts.find((c) => c.address === address);
		const name = contact?.name ?? shortAddress(address);
		if (!blocked.includes(address)) {
			const ok = await ask({
				body: t('q_block', { name }),
				confirm: t('block'),
				danger: true
			});
			if (!ok) return;
			blocked = [...blocked, address].slice(0, MAX_BLOCKED);
		} else {
			blocked = blocked.filter((a) => a !== address);
		}
		saveBlocked($state.snapshot(blocked));
		syncAll({ k: 'state', blocked: $state.snapshot(blocked) });
	}

	/** Removes the contact and its conversation from this device. */
	async function deleteContact(address: string): Promise<void> {
		menuOpen = false;
		ctx = null;
		const contact = contacts.find((c) => c.address === address);
		if (!contact) return;
		const ok = await ask({
			body: t('q_delete_contact', { name: contact.name }),
			confirm: t('delete_contact'),
			danger: true
		});
		if (!ok) return;
		contacts = contacts.filter((c) => c.address !== address);
		delete chats[address];
		clearUnread(address);
		rememberDeletes([{ c: address, s: 'k', ts: Date.now() }]);
		persist();
		if (active === address) active = null;
	}

	function openMsgMenu(x: number, y: number, message: Message): void {
		// Keep the menu inside the window.
		msgMenu = { x, y, message, at: Date.now() };
		// Clamp with the menu's real size, measured once it is on screen.
		tick().then(() => {
			const el = msgMenuEl;
			if (!el || !msgMenu) return;
			const { width, height } = el.getBoundingClientRect();
			const vw = document.documentElement.clientWidth;
			const vh = document.documentElement.clientHeight;
			const nx = Math.max(8, Math.min(x, vw - width - 8));
			// Open upwards when there is no room below the anchor.
			const ny = y + height + 8 > vh ? Math.max(8, y - height - 8) : y;
			msgMenu = { ...msgMenu, x: nx, y: Math.max(8, Math.min(ny, vh - height - 8)) };
			el.querySelector<HTMLElement>('button')?.focus();
		});
	}

	async function deleteForMe(message: Message): Promise<void> {
		msgMenu = null;
		if (!active) return;
		const peer = active;
		const ok = await ask({ body: t('q_delete_me'), confirm: t('delete_msg_me'), danger: true });
		if (!ok) return;
		const items = [{ id: message.id, mine: message.mine }];
		if (chats[peer] && removeMessages(chats[peer], items)) persist();
		rememberDeletes(items.map((i) => ({ c: peer, s: 'm' as const, id: i.id, mine: i.mine, ts: Date.now() })));
	}

	async function deleteForEveryone(message: Message): Promise<void> {
		msgMenu = null;
		if (!active || !identity || !message.mine) return;
		const peer = active;
		const ok = await ask({ body: t('q_delete_all'), confirm: t('delete_msg_all'), danger: true });
		if (!ok) return;
		// The request goes first; without a relay connection nothing is deleted anywhere.
		if (!relay?.send(peer, randomId(), encryptDelete(identity, peer, [message.id]))) {
			notice = t('n_delete_offline');
			return;
		}
		// Also pull the original back if it is still waiting on the relay (the peer is offline).
		relay.unsend(peer, message.id);
		// The attachment itself too: only the sender holds the delete token.
		if (message.att) void deleteRemote($state.snapshot(message.att));
		const items = [{ id: message.id, mine: true }];
		if (chats[peer] && removeMessages(chats[peer], items)) persist();
		rememberDeletes(items.map((i) => ({ c: peer, s: 'm' as const, id: i.id, mine: i.mine, ts: Date.now() })));
	}

	/** From the message menu: close it first, the message is passed by value. Reading the menu's own
	 * state after clearing it (as a `{@const}` inside the menu block does) throws and ends in the error page. */
	function reply(message: Message): void {
		msgMenu = null;
		startReply(message);
	}

	function startReply(message: Message): void {
		if (!active || !identity) return;
		const preview = cleanReply({
			id: message.id,
			from: message.mine ? identity.address : active,
			text: previewOf(message)
		});
		if (!preview) return;
		replyTo = preview;
		composerInput?.focus();
	}

	/** Who wrote a quoted message: "You" for our own account, else the contact's name. */
	function quoteName(from: string): string {
		if (from === identity?.address) return t('you');
		return contacts.find((c) => c.address === from)?.name ?? shortAddress(from);
	}

	/** Scrolls to the original and flashes it. Does nothing when it is no longer in this chat. */
	function jumpTo(reply: Reply): void {
		const key = (reply.from === identity?.address ? 'm' : 't') + reply.id;
		const target = Array.from(scroller?.children ?? []).find(
			(el) => (el as HTMLElement).dataset.key === key
		);
		if (!target) return;
		target.scrollIntoView({ block: 'center', behavior: 'smooth' });
		highlighted = key;
		setTimeout(() => highlighted === key && (highlighted = ''), 1500);
	}

	// Phones: holding a bubble opens its action menu.
	let pressTimer: ReturnType<typeof setTimeout> | undefined;
	function pressStart(event: PointerEvent, message: Message): void {
		if (event.pointerType !== 'touch') return;
		clearTimeout(pressTimer);
		const { clientX, clientY } = event;
		pressTimer = setTimeout(() => openMsgMenu(clientX, clientY, message), 500);
	}
	const pressEnd = () => clearTimeout(pressTimer);

	const initial = (name: string) => [...name.trim()][0] ?? '?';
	const shortAddress = (a: string) => a.slice(0, 8) + '…' + a.slice(-6);
	/** Times follow the app language: 24 hour for Turkish, Turkmen and Russian. */
	const timeOf = (ts: number) =>
		new Date(ts).toLocaleTimeString(getLanguage() === 'en' ? [] : getLanguage() === 'tk' ? 'tr' : getLanguage(), {
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: getLanguage() === 'en' ? undefined : 'h23'
		});
	const dateOf = (ts: number) => new Date(ts).toLocaleDateString(getLanguage() === 'en' ? [] : getLanguage() === 'tk' ? 'tr' : getLanguage());
	const stateLabel = (state: Message['state']) =>
		state === 'received' ? '' : t(`state_${state}`);
	/** Tick level of an own, sent message. Read is only shown while read receipts are on. */
	const tickLevel = (m: Message): 'sent' | 'delivered' | 'read' =>
		m.delivery === 'read' && receipts ? 'read' : m.delivery ? 'delivered' : 'sent';
</script>

<svelte:head>
	<title>MIGA</title>
</svelte:head>

{#snippet verifiedMark(size: number)}
	<span class="verified-mark" title={t('safety_verified')}>
		<svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={t('safety_verified')} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" />
			<path d="M8.5 12l2.5 2.5 4.5-5" />
		</svg>
	</span>
{/snippet}

{#snippet rowMeta(address: string, last: Message | undefined)}
	<span class="meta">
		{#if last}<small class="when">{timeOf(last.ts)}</small>{/if}
		<span class="marks">
			{#if muted.includes(address)}
				<svg class="mute-icon" viewBox="0 0 24 24" width="13" height="13" role="img" aria-label={t('muted_label')} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<title>{t('muted_label')}</title>
					<path d="M6 8a6 6 0 0 1 9.3-5M18 8c0 3 .7 5 2 7H5M10 21a2 2 0 0 0 4 0M3 3l18 18" />
				</svg>
			{/if}
			{#if unread[address]}
				<span class="badge" class:quiet={muted.includes(address)} data-unread={unread[address]} aria-label={t('unread_count', { n: unread[address] })}>
					{unread[address] > 99 ? '99+' : unread[address]}
				</span>
			{/if}
		</span>
	</span>
{/snippet}

{#snippet globalBar(slot: number)}
	{#if gOpen}
		<div class="gsearch" role="search">
			<input
				bind:this={gFields[slot]}
				bind:value={gInput}
				type="search"
				autocomplete="off"
				data-gfield
				placeholder={t('search_all_placeholder')}
				aria-label={t('search_all_placeholder')}
				oninput={onGlobalInput}
				onkeydown={(e) => e.key === 'Escape' && (e.preventDefault(), closeGlobal())}
			/>
			<button type="button" class="ibtn" title={t('search_close')} aria-label={t('search_close')} onclick={closeGlobal}><Icon name="close" /></button>
		</div>
		{#if gResults}
			<div class="gresults" data-total={gResults.total}>
				{#each gResults.groups as group (group.chat)}
					<section class="ggroup">
						<h3>{nameOf(group.chat)}</h3>
						<ul>
							{#each group.hits as hit (hit.mine + hit.id)}
								<li>
									<button type="button" class="ghit" onclick={() => { closeGlobal(); void openHit(group.chat, hit); }}>
										<span class="gsnip">{#each snippet(hit.text, gQuery) as seg, si (si)}{#if seg.hit}<mark>{seg.t}</mark>{:else}{seg.t}{/if}{/each}</span>
										<small>{dateOf(hit.ts)} {timeOf(hit.ts)}</small>
									</button>
								</li>
							{/each}
						</ul>
					</section>
				{:else}
					<p class="empty center">{t('search_all_none')}</p>
				{/each}
				{#if gResults.total > GLOBAL_LIMIT}<p class="empty center">{t('search_more', { n: GLOBAL_LIMIT })}</p>{/if}
			</div>
		{/if}
	{/if}
{/snippet}

{#snippet hxBanner()}
	{#if hx || hxFlash}
		<div class="hx-banner" role="status" data-hx-percent={hxPercent}>
			<p>{hx ? t('hx_progress', { n: hxPercent }) : t('hx_done')}</p>
			<div class="hx-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={hxPercent} aria-label={t('hx_progress', { n: hxPercent })}>
				<span style:width="{hxPercent}%"></span>
			</div>
		</div>
	{/if}
{/snippet}

{#snippet notifyBanner()}
	{#if notifyPerm === 'default' && !bannerDismissed && identity}
		<div class="notify-banner" role="region" aria-label={t('notif_title')}>
			<p>{t('notif_banner')}</p>
			<div class="row">
				<button type="button" class="primary" onclick={enableNotifications}>{t('notif_enable')}</button>
				<button type="button" onclick={dismissBanner}>{t('notif_not_now')}</button>
			</div>
		</div>
	{/if}
{/snippet}

{#snippet profileFields()}
	<label class="field">
		<span>{t('profile_name')}</span>
		<input bind:value={profile.name} placeholder={t('name_unknown')} autocomplete="off" maxlength="40" />
	</label>
	<label class="check">
		<input type="checkbox" bind:checked={profile.share} />
		<span>{t('profile_share')}</span>
	</label>
	<p class="hint">{t('profile_note')}</p>
{/snippet}

<div class="shell" class:desktop={isDesktop} class:sub={view !== 'chat' && !!identity} class:chat-open={active !== null || view !== 'chat'}>
	{#if !isDesktop}
	<header class="top">
		{#if platform.target === 'web'}
			<a class="brand" href="/">
				<Logo size={30} />
				<span>MIGA</span>
				<span class="ver" title={VERSION_TITLE}>{VERSION_LABEL}</span>
			</a>
		{:else}
			<span class="brand">
				<Logo size={30} />
				<span>MIGA</span>
				<span class="ver" title={VERSION_TITLE}>{VERSION_LABEL}</span>
			</span>
		{/if}
		<nav aria-label="Main">
			<a class="link" href="https://vniverse77.com/">Vniverse77</a>
			<a class="link" href="https://forum.vniverse77.com/">Forum</a>
			<span class="status {status}">{t(`status_${status}`)}</span>
			<LangSelect />
		</nav>
	</header>
	{/if}

	{#if ready && !identity}
		<div class="onboard">
			{#if isDesktop}<div class="onboard-lang"><LangSelect /></div>{/if}
			{#if onboard === 'create'}
				<form class="card" onsubmit={createAddress}>
					<Logo size={56} />
					<h1>{t('ob_title')}</h1>
					<p class="lead">{t('ob_text')}</p>
					{@render profileFields()}
					<button type="submit" class="primary">{t('ob_create')}</button>
					<div class="row">
						<button type="button" onclick={() => ((onboard = 'link'), (notice = ''))}>
							{t('ob_link')}
						</button>
						<button type="button" onclick={restoreKey}>{t('ob_restore')}</button>
					</div>
					{#if notice}<p class="notice" role="status">{notice}</p>{/if}
				</form>
			{:else}
				<form class="card" onsubmit={linkThisDevice}>
					<Logo size={56} />
					<h1>{t('ob_link')}</h1>
					<p class="lead">{t('ob_link_help')}</p>
					<input
						class="code-input"
						bind:value={codeInput}
						placeholder="XXXX-XXXX-XXXX"
						autocomplete="off"
						autocapitalize="characters"
						spellcheck="false"
						maxlength="20"
						disabled={linking}
					/>
					<button type="submit" class="primary" disabled={linking || !codeInput.trim()}>
						{linking ? t('link_wait') : t('link_go')}
					</button>
					<button type="button" class="with-icon" disabled={linking} onclick={() => (scanning = 'link')}><Icon name="scan" size={16} />{t('scan_button')}</button>
					<button type="button" disabled={linking} onclick={() => ((onboard = 'create'), (notice = ''))}>
						← {t('back')}
					</button>
					{#if notice}<p class="notice" role="status">{notice}</p>{/if}
				</form>
			{/if}
		</div>
	{:else}
		{#if isDesktop}
		<aside class="side">
			<div class="side-top">
				<Logo size={24} />
				<span class="wordmark">MIGA</span>
				<span class="status {status}">{t(`status_${status}`)}</span>
				<button type="button" class="ibtn" data-gsearch title={t('search_all')} aria-label={t('search_all')} aria-pressed={gOpen} onclick={toggleGlobal}><Icon name="search" /></button>
				{#if contacts.length}
				<button type="button" class="ibtn" title={t('new_conversation')} aria-label={t('new_conversation')} onclick={openNew}>
					<Icon name="plus" />
				</button>
				{/if}
			</div>

			{@render globalBar(0)}
			{#if gResults === null}{@render hxBanner()}{@render notifyBanner()}{/if}
			<ul class="contacts side-list" class:hidden={gResults !== null}>
				{#each contacts as contact (contact.address)}
					{@const last = chats[contact.address]?.at(-1)}
					<li>
						<button
							type="button"
							class="contact"
							class:selected={view === 'chat' && contact.address === active}
							onclick={() => openChat(contact.address)}
							oncontextmenu={(e) => openMenu(e, contact.address)}
						>
							<span class="avatar" aria-hidden="true">{initial(contact.name)}</span>
							<span class="who">
								<strong>{contact.name}{#if contact.verified}{@render verifiedMark(14)}{/if}</strong>
								<small>{last ? previewOf(last) : shortAddress(contact.address)}</small>
							</span>
							{@render rowMeta(contact.address, last)}
						</button>
					</li>
				{:else}
					<li class="empty">
						<p>{t('no_conversations')}</p>
						<button type="button" class="primary" onclick={openNew}>{t('new_conversation')}</button>
					</li>
				{/each}
			</ul>

			{#if notice && view === 'chat'}
				<p class="notice" role="status">{notice}</p>
			{/if}

			<div
				class="side-bottom"
				class:on={view === 'settings'}
				role="button"
				tabindex="0"
				title={t('settings')}
				onclick={toggleSettings}
				onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleSettings())}
			>
				<span class="avatar" aria-hidden="true">{initial(myName || '?')}</span>
				<span class="who">
					<strong>{myName || t('name_unknown')}</strong>
					<small>
						{myName ? t(profile.share ? 'profile_visible' : 'profile_hidden') : t('profile_anon')}
					</small>
				</span>
				<button
					type="button"
					class="ibtn gear"
					class:on={view === 'settings'}
					title={t('settings')}
					aria-label={t('settings')}
					onclick={(e) => (e.stopPropagation(), toggleSettings())}
				>
					<Icon name="settings" />
				</button>
			</div>
		</aside>
		{:else}
		<aside>
			<div class="profile">
				<span class="avatar" aria-hidden="true">{initial(myName || '?')}</span>
				<span class="who">
					<strong>{myName || t('name_unknown')}</strong>
					<small>
						{myName ? t(profile.share ? 'profile_visible' : 'profile_hidden') : t('profile_anon')}
					</small>
				</span>
				<button
					type="button"
					class="ibtn"
					class:on={view === 'settings'}
					title={t('settings')}
					aria-label={t('settings')}
					onclick={() => (view = view === 'settings' ? 'chat' : 'settings')}
				>
					<Icon name="settings" />
				</button>
			</div>

			<div class="list-head">
				<h2>{t('chats')}</h2>
				<span class="head-actions">
				<button type="button" class="ibtn" data-gsearch title={t('search_all')} aria-label={t('search_all')} aria-pressed={gOpen} onclick={toggleGlobal}><Icon name="search" /></button>
				{#if contacts.length}
				<button type="button" class="ibtn primary" title={t('new_conversation')} aria-label={t('new_conversation')} onclick={openNew}>
					<Icon name="plus" />
				</button>
				{/if}
				</span>
			</div>

			{@render globalBar(1)}
			{#if notice && view === 'chat'}
				<p class="notice" role="status">{notice}</p>
			{/if}

			{#if gResults === null}{@render hxBanner()}{@render notifyBanner()}{/if}
			<ul class="contacts" class:hidden={gResults !== null}>
				{#each contacts as contact (contact.address)}
					{@const last = chats[contact.address]?.at(-1)}
					<li>
						<button
							type="button"
							class="contact"
							class:selected={view === 'chat' && contact.address === active}
							onclick={() => openChat(contact.address)}
						>
							<span class="avatar" aria-hidden="true">{initial(contact.name)}</span>
							<span class="who">
								<strong>{contact.name}{#if contact.verified}{@render verifiedMark(14)}{/if}</strong>
								<small>{last ? previewOf(last) : shortAddress(contact.address)}</small>
							</span>
							{@render rowMeta(contact.address, last)}
						</button>
					</li>
				{:else}
					<li class="empty">
						<p>{t('no_conversations')}</p>
						<button type="button" class="primary" onclick={openNew}>{t('new_conversation')}</button>
					</li>
				{/each}
			</ul>
		</aside>
		{/if}

		<main ondragover={onDragOver} ondragleave={() => (dragging = false)} ondrop={onDrop} class:dragging>
			{#if view === 'settings'}
				<header class="chat-head">
					<button type="button" class="ibtn back" title={t('back')} aria-label={t('back')} onclick={() => (view = 'chat')}><Icon name="back" /></button>
					<div class="who title"><Icon name="settings" size={18} /><strong>{t('settings')}</strong></div>
					<button type="button" class="ibtn close" aria-label={t('close')} title={t('close')} onclick={() => (view = 'chat')}>
						<Icon name="close" />
					</button>
				</header>

				<div class="settings">
					<section class="card">
						<h2>{t('your_address')}</h2>
						<code class="selectable">{identity?.address ?? '…'}</code>
						<button type="button" class="with-icon" onclick={copyAddress}><Icon name="copy" size={16} />{t('copy_address')}</button>
						{#if inviteUrl}
							<h3>{t('qr_contact_title')}</h3>
							<QrCode text={inviteUrl} label={t('qr_contact_title')} />
							<p class="hint">{t('qr_contact_help')}</p>
						{/if}
						{#if notice}<p class="notice" role="status">{notice}</p>{/if}
					</section>

					<form class="card" onsubmit={saveProfileForm}>
						<h2>{t('set_profile')}</h2>
						{@render profileFields()}
						<button type="submit" class="primary">{t('save')}</button>
					</form>

					<section class="card">
						<h2>{t('receipts_title')}</h2>
						<label class="check">
							<input
								type="checkbox"
								checked={receipts}
								onchange={(e) => setReceipts(e.currentTarget.checked)}
							/>
							<span>{t('receipts_label')}</span>
						</label>
						<p class="hint">{t('receipts_note')}</p>
					</section>

					<section class="card" id="live-typing">
						<h2>{t('live_title')}</h2>
						<label class="check">
							<input
								type="checkbox"
								checked={liveOn}
								onchange={(e) => setLive(e.currentTarget.checked)}
							/>
							<span>{t('live_label')}</span>
						</label>
						<p class="hint">{t('live_note')}</p>
					</section>

					<section class="card" id="notifications">
						<h2>{t('notif_title')}</h2>
						<p class="hint" data-notif-state={notifyPerm}>{t(`notif_state_${notifyPerm === 'granted' ? 'on' : notifyPerm}`)}</p>
						{#if notifyPerm === 'default'}
							<button type="button" class="primary" onclick={enableNotifications}>{t('notif_enable')}</button>
						{/if}
						<h3>{t('notif_content')}</h3>
						<div class="seg seg-wide" role="group" aria-label={t('notif_content')}>
							{#each ['full', 'name', 'generic'] as const as mode (mode)}
								<button type="button" aria-pressed={notifyMode === mode} onclick={() => setNotifyMode(mode)}>
									{t(`notif_${mode}`)}
								</button>
							{/each}
						</div>
						<p class="hint">{t('notif_privacy')}</p>
						<p class="hint">{t('notif_note')}</p>
					</section>

					<section class="card">
						<h2>{t('set_devices')}</h2>
						<ul class="devices">
							<li>
								<span class="who">
									<strong>{deviceLabel}</strong>
									<small>{t('dev_this')}</small>
								</span>
							</li>
							{#each devices as other (other.address)}
								<li>
									<span class="who">
										<strong>{other.label}</strong>
										<small>{dateOf(other.added)}</small>
									</span>
									<button type="button" class="ibtn" data-hx-from title={t('dev_resync')} aria-label={t('dev_resync')} disabled={!!hx} onclick={() => copyHistoryFrom(other.address)}>
										<Icon name="download" />
									</button>
									<button type="button" class="ibtn" title={t('dev_remove')} aria-label={t('dev_remove')} onclick={() => removeDevice(other.address)}>
										<Icon name="trash" />
									</button>
								</li>
							{:else}
								<li class="empty">{t('dev_none')}</li>
							{/each}
						</ul>

						{#if link}
							<div class="link-box">
								<h3>{t('dev_code_title')}</h3>
<QrCode text={appUrl(platform.publicOrigin(), { link: link.code })} label={t('qr_link_title')} />
								<p class="hint warn">{t('qr_link_warn')}</p>
								<p class="code selectable">{formatLinkCode(link.code)}</p>
								<p class="hint">{t('dev_code_help')}</p>
								<button type="button" onclick={() => endLink('')}>{t('cancel')}</button>
							</div>
						{:else}
							<button type="button" class="primary with-icon" onclick={addDevice}><Icon name="device-add" size={16} />{t('dev_add')}</button>
						{/if}
						{#if linkNotice}<p class="notice" role="status">{linkNotice}</p>{/if}
						<p class="hint">{t('dev_hint')}</p>
					</section>

					<section class="card">
						<h2>{t('set_blocked')}</h2>
						<ul class="devices blocked-list">
							{#each blocked as address (address)}
								{@const known = contacts.find((c) => c.address === address)}
								<li>
									<span class="who">
										<strong>{known?.name ?? shortAddress(address)}</strong>
										{#if known}<small>{shortAddress(address)}</small>{/if}
									</span>
									<button type="button" onclick={() => toggleBlock(address)}>{t('unblock')}</button>
								</li>
							{:else}
								<li class="empty">{t('blocked_none')}</li>
							{/each}
						</ul>
						<p class="hint">{t('blocked_help')}</p>
					</section>

					<section class="card">
						<h2>{t('set_key')}</h2>
						<p class="hint">{t('set_key_help')}</p>
						<div class="row">
							<button type="button" onclick={backupKey}>{t('backup_key')}</button>
							<button type="button" onclick={restoreKey}>{t('restore')}</button>
						</div>
					</section>

					<section class="card">
						<h2>{t('set_theme')}</h2>
						<div class="seg" role="group" aria-label={t('set_theme')}>
							{#each ['dark', 'light', 'system'] as const as choice (choice)}
								<button type="button" aria-pressed={getTheme() === choice} onclick={() => setTheme(choice as Theme)}>
									{t(`theme_${choice}`)}
								</button>
							{/each}
						</div>
					</section>

<section class="card">
						<h2>{t('language')}</h2>
						<div class="lang-row"><LangSelect /></div>
					</section>

					<section class="card">
						<h2>{t('set_erase')}</h2>
						<p class="hint">{t('set_erase_help')}</p>
						<button type="button" class="danger" onclick={eraseThisDevice}>{t('erase')}</button>
					</section>
	{#if isDesktop}
						<section class="card">
							<h2>{t('set_about')}</h2>
							<p class="about-name"><strong>MIGA</strong> <span class="ver selectable" title={VERSION_TITLE}>{VERSION_LABEL}</span></p>
							<p class="hint">{t('about_text')}</p>
							<div class="row about-links">
								<button type="button" onclick={() => platform.openExternal('https://github.com/Vniverse77/MIGA')}>{t('nav_source')}</button>
								<button type="button" onclick={() => platform.openExternal('https://forum.vniverse77.com/')}>{t('about_forum')}</button>
								<button type="button" onclick={() => platform.openExternal('https://vniverse77.com/')}>Vniverse77</button>
							</div>
						</section>
					{/if}
				</div>
			{:else if view === 'new'}
				<header class="chat-head">
					<button type="button" class="ibtn back" title={t('back')} aria-label={t('back')} onclick={() => (view = 'chat')}><Icon name="back" /></button>
					<div class="who title"><Icon name="plus" size={18} /><strong>{t('new_conversation')}</strong></div>
					<button type="button" class="ibtn close" aria-label={t('close')} title={t('close')} onclick={() => (view = 'chat')}>
						<Icon name="close" />
					</button>
				</header>

				<div class="settings">
					<form class="card" onsubmit={addContact}>
						<input bind:value={newAddress} placeholder={t('ph_address')} autocomplete="off" spellcheck="false" enterkeyhint="next" onkeydown={(e) => onEnter(e, () => (e.currentTarget as HTMLInputElement).form?.querySelectorAll('input')[1]?.focus())} />
						<input bind:value={newName} placeholder={t('ph_name')} autocomplete="off" maxlength="40" enterkeyhint="go" onkeydown={(e) => onEnter(e, () => addContact())} />
						<button type="submit" class="primary">{t('start_chat')}</button>
						<button type="button" class="with-icon" onclick={() => (scanning = 'to')}><Icon name="scan" size={16} />{t('scan_button')}</button>
						{#if notice}<p class="notice" role="status">{notice}</p>{/if}
					</form>

					<section class="card">
						<h2>{t('your_address')}</h2>
						<code class="selectable">{identity?.address ?? '…'}</code>
						<button type="button" class="with-icon" onclick={copyAddress}><Icon name="copy" size={16} />{t('copy_address')}</button>
					</section>
				</div>
			{:else if view === 'verify' && activeContact}
				<header class="chat-head">
					<button type="button" class="ibtn back" title={t('back')} aria-label={t('back')} onclick={() => (view = 'chat')}><Icon name="back" /></button>
					<div class="who title"><Icon name="shield" size={18} /><strong>{t('safety_title')}</strong></div>
					<button type="button" class="ibtn close" aria-label={t('close')} title={t('close')} onclick={() => (view = 'chat')}>
						<Icon name="close" />
					</button>
				</header>

				<div class="settings">
					<section class="card safety">
						<p class="hint">{t('safety_help', { name: activeContact.name })}</p>
						<div class="safety-number selectable" data-safety={activeSafety} aria-label={groupSafety(activeSafety)}>
							{#each groupSafety(activeSafety).split(' ') as group, i (i)}<span>{group}</span>{/each}
						</div>
						<QrCode text={appUrl(platform.publicOrigin(), { verify: activeSafety })} label={t('safety_qr')} />
						<p class="safety-state" class:ok={!!activeContact.verified} data-verified={activeContact.verified ? '1' : '0'}>
							{#if activeContact.verified}{@render verifiedMark(16)}{/if}
							{t(activeContact.verified ? 'safety_verified' : 'safety_not_verified')}
						</p>
						{#if verifyResult === 'match'}
							<p class="notice" role="status" data-result="match">{t('safety_match', { name: activeContact.name })}</p>
						{:else if verifyResult === 'mismatch'}
							<p class="notice warn-box" role="alert" data-result="mismatch">{t('safety_mismatch')}</p>
						{/if}
						<div class="row">
							<button type="button" class="primary" onclick={() => ((verifyResult = null), (scanning = 'verify'))}>{t('safety_scan')}</button>
							<button type="button" onclick={copySafety}>{t('safety_copy')}</button>
							{#if activeContact.verified}
								<button type="button" onclick={() => ((verifyResult = null), setVerified(activeContact.address, false))}>{t('safety_clear')}</button>
							{:else}
								<button type="button" onclick={() => setVerified(activeContact.address, true)}>{t('safety_mark')}</button>
							{/if}
						</div>
						{#if notice}<p class="notice" role="status">{notice}</p>{/if}
					</section>
				</div>
			{:else if activeContact}
				<header class="chat-head">
					<button type="button" class="ibtn back" title={t('back')} aria-label={t('back')} onclick={() => (active = null)}><Icon name="back" /></button>
					<span class="avatar" aria-hidden="true">{initial(activeContact.name)}</span>
					<div class="who">
						<strong>{activeContact.name}{#if activeContact.verified}{@render verifiedMark(14)}{/if}</strong>
<small class="selectable">{shortAddress(activeContact.address)}</small>
					</div>
					<span class="lock">{t('f1_title')}</span>
					<button type="button" class="ibtn" data-search-open title={t('search_chat')} aria-label={t('search_chat')} aria-pressed={searchOpen} onclick={() => (searchOpen ? closeSearch() : openSearch())}><Icon name="search" /></button>
					<div class="menu-wrap">
						<button
							type="button"
							class="ibtn kebab"
							aria-label={t('chat_menu')}
							aria-haspopup="menu"
							aria-expanded={menuOpen}
							onclick={() => (menuOpen = !menuOpen)}
						>
							<Icon name="more-v" />
						</button>
						{#if menuOpen}
							<div class="menu" role="menu">
								<button type="button" role="menuitem" onclick={() => openVerify(activeContact.address)}>
									<Icon name="shield" size={16} />{t('verify_safety')}
								</button>
								<button type="button" role="menuitem" onclick={() => toggleMute(activeContact.address)}>
									<Icon name={muted.includes(activeContact.address) ? 'bell' : 'bell-off'} size={16} />{t(muted.includes(activeContact.address) ? 'unmute_chat' : 'mute_chat')}
								</button>
								<button
									type="button"
									role="menuitem"
									class="danger"
									onclick={() => deleteConversation(activeContact.address)}
								>
									<Icon name="trash" size={16} />{t('delete_chat')}
								</button>
								<button
									type="button"
									role="menuitem"
									class="danger"
									onclick={() => deleteContact(activeContact.address)}
								>
									<Icon name="user-x" size={16} />{t('delete_contact')}
								</button>
								<button
									type="button"
									role="menuitem"
									class={blocked.includes(activeContact.address) ? '' : 'danger'}
									onclick={() => toggleBlock(activeContact.address)}
								>
									<Icon name="block" size={16} />{t(blocked.includes(activeContact.address) ? 'unblock' : 'block')}
								</button>
							</div>
						{/if}
					</div>
				</header>

				{#if activeContact.keyChanged}
					<div class="safety-banner" role="alert">
						<p>{t('safety_changed', { name: activeContact.name })}</p>
						<div class="row">
							<button type="button" class="primary" onclick={() => openVerify(activeContact.address)}>{t('verify_safety')}</button>
							<button type="button" onclick={() => dismissChanged(activeContact.address)}>{t('safety_dismiss')}</button>
						</div>
					</div>
				{/if}

				{#if searchOpen}
					<div class="searchbar" role="search" data-ms={searchMs}>
						<input
							bind:this={searchField}
							bind:value={searchInput}
							type="search"
							autocomplete="off"
							placeholder={t('search_placeholder')}
							aria-label={t('search_placeholder')}
							oninput={onSearchInput}
							onkeydown={onSearchKey}
						/>
						<span class="count" aria-live="polite" data-count={searchHits.length}>
							{#if !searchQuery.trim()}{:else if searchHits.length}{searchCur + 1} / {searchHits.length}{:else}{t('search_none')}{/if}
						</span>
						<button type="button" class="ibtn" data-search-prev title={t('search_prev')} aria-label={t('search_prev')} disabled={!searchHits.length} onclick={() => stepSearch(-1)}><Icon name="chevron-up" /></button>
						<button type="button" class="ibtn" data-search-next title={t('search_next')} aria-label={t('search_next')} disabled={!searchHits.length} onclick={() => stepSearch(1)}><Icon name="chevron-down" /></button>
						<button type="button" class="ibtn" data-search-close title={t('search_close')} aria-label={t('search_close')} onclick={closeSearch}><Icon name="close" /></button>
					</div>
				{/if}

				<div class="messages" bind:this={scroller} onscroll={checkSeen}>
					{#each activeMessages as message (message.mine + message.id)}
						<div
							class="bubble"
							class:mine={message.mine}
							class:failed={message.state === 'failed'}
							class:emoji-only={isEmojiOnly(message.text)}
							class:flash={highlighted === (message.mine ? 'm' : 't') + message.id}
							data-key={(message.mine ? 'm' : 't') + message.id}
							role="group"
							oncontextmenu={(e) => {
								// Mouse right-click opens the action menu (but keeps the browser's copy menu on a selection).
								if ((e as unknown as PointerEvent).pointerType === 'touch' || getSelection()?.toString()) return;
								e.preventDefault();
								openMsgMenu(e.clientX, e.clientY, message);
							}}
							onpointerdown={(e) => pressStart(e, message)}
							onpointerup={pressEnd}
							onpointercancel={pressEnd}
							onpointermove={pressEnd}
						>
							{#if message.reply}
								<button type="button" class="quote" onclick={() => message.reply && jumpTo(message.reply)}>
									<strong>{quoteName(message.reply.from)}</strong>
									<span>{message.reply.text}</span>
								</button>
							{/if}
							{#if message.att}
								<Attachment att={message.att} onview={(url, a) => (viewer = { url, mime: a.mime })} />
							{/if}
							{#if message.text || !message.att}
								<p class="selectable">{#if searchKeys.has(messageKey(message))}{#each segments(message.text, searchQuery) as seg, si (si)}{#if seg.hit}<mark class:cur={messageKey(message) === searchCurKey}>{seg.t}</mark>{:else}{seg.t}{/if}{/each}{:else}{#each linkify(message.text) as part, pi (pi)}{#if part.url}<a href={part.url} target="_blank" rel="noopener noreferrer" onclick={(e) => (e.preventDefault(), platform.openExternal(part.url as string))}>{part.t}</a>{:else}{part.t}{/if}{/each}{/if}</p>
							{/if}
							<div class="foot">
							<small>
								{#if message.edited}<span class="edited">{t('edited')}</span>{' · '}{/if}{timeOf(message.ts)}{#if message.mine}{' · '}{#if message.state === 'sent'}{@const level = tickLevel(message)}<span
										class="ticks {level}"
										data-level={level}
										role="img"
										aria-label={t(`state_${level}`)}
										title={t(`state_${level}`)}
									>
										<svg viewBox="0 0 32 24" width="22" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<path d="M3 13l4.5 4.5L16.5 8" />
											{#if level !== 'sent'}<path d="M13 13l4.5 4.5L27 8" />{/if}
										</svg>
									</span>{:else}{stateLabel(message.state)}{/if}{/if}
							</small>
							<span class="acts">
							<button
								type="button"
								class="reply-btn"
								aria-label={t('reply')}
								title={t('reply')}
								onclick={() => startReply(message)}
							>
								<Icon name="reply" size={14} />
							</button>
							<button
								type="button"
								class="reply-btn act-btn"
								aria-label={t('msg_actions')}
								aria-haspopup="menu"
								title={t('msg_actions')}
								onclick={(e) => {
									const r = e.currentTarget.getBoundingClientRect();
									openMsgMenu(r.left, r.bottom + 4, message);
								}}
							>
								<Icon name="more" size={14} />
							</button>
							</span>
							</div>
						</div>
					{:else}
						{#if !uploads.some((u) => u.peer === active)}<p class="empty-box">{t('no_messages')}</p>{/if}
					{/each}
					{#each uploads.filter((u) => u.peer === active) as u (u.key)}
						<div class="bubble mine uploading" class:failed={u.state === 'failed'} data-upload={u.state}>
							<div class="up-box" style:aspect-ratio={u.w / u.h} style:--ratio={u.w / u.h}>
								{#if u.thumb}<img src={u.thumb} alt="" aria-hidden="true" />{/if}
								<div class="up-over">
									{#if u.state === 'failed'}
										<p role="alert">{t(u.error === 'quota' || u.error === 'rate' || u.error === 'network' ? (`att_${u.error}` as 'att_network') : 'att_failed')}</p>
										<div class="row">
											<button type="button" onclick={() => sendUpload(u.key)}>{t('att_retry')}</button>
											<button type="button" onclick={() => cancelUpload(u.key)}>{t('att_remove')}</button>
										</div>
									{:else}
										<p>{u.state === 'preparing' ? t('att_preparing') : t('att_sending', { pct: Math.round(u.progress * 100) })}</p>
										<progress max="1" value={u.state === 'preparing' ? undefined : u.progress}></progress>
										<button type="button" onclick={() => cancelUpload(u.key)}>{t('att_cancel')}</button>
									{/if}
								</div>
							</div>
							{#if u.caption}<p class="selectable">{u.caption}</p>{/if}
						</div>
					{/each}
					{#if liveIn && liveIn.peer === active}
						<div class="live-line" data-live aria-live="off">
							<span class="live-tag">{t('live_tag')}</span>
							<span class="live-text">{liveIn.text}</span>
						</div>
					{/if}
				</div>

				{#if replyTo}
					<div class="replybar">
						<div class="quote-text">
							<strong>{replyTo.from === identity?.address ? t('replying_to_self') : t('replying_to', { name: quoteName(replyTo.from) })}</strong>
							<span>{replyTo.text}</span>
						</div>
						<button type="button" aria-label={t('cancel_reply')} title={t('cancel_reply')} onclick={() => (replyTo = null)}><Icon name="close" size={16} /></button>
					</div>
				{/if}
				{#if editing}
					<div class="replybar editbar">
						<div class="quote-text">
							<strong>{t('editing_msg')}</strong>
							<span>{editing.text}</span>
						</div>
						<button type="button" aria-label={t('cancel_edit')} title={t('cancel_edit')} onclick={cancelEdit}><Icon name="close" size={16} /></button>
					</div>
				{/if}
				{#if emojiOpen && EmojiPicker && !blocked.includes(activeContact.address)}
					<EmojiPicker onpick={insertEmoji} />
				{/if}
				{#if gifOpen && GifPanel && !blocked.includes(activeContact.address)}
					<GifPanel onsend={sendGif} onnotice={showGifNotice} />
				{/if}
				{#if blocked.includes(activeContact.address)}
					<div class="replybar blocked-bar">
						<div class="quote-text"><span>{t('blocked_banner')}</span></div>
						<button type="button" onclick={() => toggleBlock(activeContact.address)}>{t('unblock')}</button>
					</div>
				{:else}
				{#if attError}<p class="att-error" role="alert">{attError}</p>{/if}
				<form class="composer" onsubmit={sendMessage}>
					<button type="button" class="attach-btn" aria-label={t('att_btn')} title={t('att_btn')} disabled={!!editing} onclick={pickFiles}>
						<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M21 12.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.2-8.2" />
						</svg>
					</button>
					<button
						type="button"
						class="emoji-btn"
						aria-label={t('emoji_btn')}
						title={t('emoji_btn')}
						aria-haspopup="dialog"
						aria-expanded={emojiOpen}
						onclick={toggleEmoji}
					>
						<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="9" />
							<path d="M8.5 14a4 4 0 0 0 7 0" />
							<path d="M9 9.5h.01M15 9.5h.01" />
						</svg>
					</button>
					<button
						type="button"
						class="gif-btn"
						aria-label={t('gif_btn')}
						title={t('gif_btn')}
						aria-haspopup="dialog"
						aria-expanded={gifOpen}
						disabled={!!editing}
						onclick={toggleGif}
					>
						<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect x="3" y="6" width="18" height="12" rx="2" />
							<path d="M10 10.5a1.8 1.8 0 1 0 0 3v-1.2H8.8M13 10v4M15.5 14v-4h2" />
						</svg>
					</button>
					<textarea class="composer-input" rows="1" bind:this={composerInput} bind:value={draft} oninput={growComposer} onkeydown={onComposerKey} onfocus={() => (composerFocused = true)} onblur={() => (composerFocused = false)} onpaste={onPaste} placeholder={t('ph_message')} enterkeyhint="send" autocomplete="off" autocapitalize="sentences" maxlength={MAX_TEXT}></textarea>
					<button
						type="submit"
						class="ibtn primary send-btn"
						title={editing ? t('save_edit') : t('send')}
						aria-label={editing ? t('save_edit') : t('send')}
						disabled={!draft.trim() && !editing}
					>
						<Icon name={editing ? 'check' : 'send'} />
					</button>
				</form>
				<input bind:this={fileInput} class="file-input" type="file" multiple accept="image/*,video/mp4,video/webm" tabindex="-1" aria-hidden="true" onchange={(e) => { void attachFiles([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ''; }} />
				{/if}
			{:else}
<div class="welcome">
					{#if !isDesktop}
						<Logo size={72} />
						<h1>MIGA</h1>
						<p class="tagline">Make Internet Great Again</p>
					{/if}
					<p>{t('pick')}</p>
					<button type="button" class="primary" onclick={openNew}>{t('new_conversation')}</button>
				</div>
			{/if}
		</main>
	{/if}
</div>

{#if ctx}
	<div class="menu ctx" role="menu" style:left="{ctx.x}px" style:top="{ctx.y}px">
		<button type="button" role="menuitem" onclick={() => ctx && openVerify(ctx.address)}>
			<Icon name="shield" size={16} />{t('verify_safety')}
		</button>
		<button type="button" role="menuitem" onclick={() => ctx && toggleMute(ctx.address)}>
			<Icon name={ctx && muted.includes(ctx.address) ? 'bell' : 'bell-off'} size={16} />{t(ctx && muted.includes(ctx.address) ? 'unmute_chat' : 'mute_chat')}
		</button>
		<button type="button" role="menuitem" class="danger" onclick={() => ctx && deleteConversation(ctx.address)}>
			<Icon name="trash" size={16} />{t('delete_chat')}
		</button>
		<button type="button" role="menuitem" class="danger" onclick={() => ctx && deleteContact(ctx.address)}>
			<Icon name="user-x" size={16} />{t('delete_contact')}
		</button>
		<button type="button" role="menuitem" onclick={() => ctx && toggleBlock(ctx.address)}>
			<Icon name="block" size={16} />{t(ctx && blocked.includes(ctx.address) ? 'unblock' : 'block')}
		</button>
	</div>
{/if}

{#if msgMenu}
	{@const target = msgMenu.message}
	<div
		class="menu ctx msg-menu"
		role="menu"
		bind:this={msgMenuEl}
		style:left="{msgMenu.x}px"
		style:top="{msgMenu.y}px"
	>
		<button type="button" role="menuitem" onclick={() => reply(target)}>
			<Icon name="reply" size={16} />{t('reply')}
		</button>
		{#if target.mine && target.state === 'sent'}
			<button type="button" role="menuitem" onclick={() => startEdit(target)}>
				<Icon name="edit" size={16} />{t('edit_msg')}
			</button>
		{/if}
		<button type="button" role="menuitem" class="danger" onclick={() => deleteForMe(target)}>
			<Icon name="trash" size={16} />{t('delete_msg_me')}
		</button>
		{#if target.mine}
			<button type="button" role="menuitem" class="danger" onclick={() => deleteForEveryone(target)}>
				<Icon name="trash" size={16} />{t('delete_msg_all')}
			</button>
		{/if}
	</div>
{/if}

{#if viewer}
	<Viewer url={viewer.url} mime={viewer.mime} onclose={() => (viewer = null)} />
{/if}

<ConfirmDialog />
{#if scanning}
	<Scanner accept={scanning} onresult={scanned} onclose={() => (scanning = null)} />
{/if}

<svelte:window
	onkeydown={(e) => e.key === 'Escape' && onEscape()}
	onclick={(e) => {
		ctx = null;
		if (emojiOpen && !(e.target as Element | null)?.closest?.('.emoji-panel, .emoji-btn')) emojiOpen = false;
		if (gifOpen && !(e.target as Element | null)?.closest?.('.gif-panel, .gif-btn')) gifOpen = false;
		// A long-press may be followed by a click on touch screens; keep the menu it just opened.
		if (msgMenu && Date.now() - msgMenu.at > 400 && !(e.target as Element | null)?.closest?.('.act-btn')) msgMenu = null;
		if (!(e.target as Element | null)?.closest?.('.menu-wrap')) menuOpen = false;
	}}
	onblur={() => ((menuOpen = false), (ctx = null), (msgMenu = null))}
	onresize={() => ((menuOpen = false), (ctx = null), (msgMenu = null))}
/>

<style>
	.shell {
		display: grid;
		grid-template-columns: 22rem 1fr;
		grid-template-rows: 3.5rem 1fr;
		height: 100dvh;
	}

	/* Top bar, same as the landing page */
	.top {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0 1.25rem;
		border-bottom: 0.5px solid var(--line);
		background: var(--panel);
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		color: var(--heading);
		font-weight: 700;
		letter-spacing: 0.14em;
		text-decoration: none;
	}
	.ver {
		font-size: 0.68rem;
		font-weight: 500;
		letter-spacing: 0.04em;
		color: var(--muted);
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		padding: 0.05rem 0.4rem;
	}
	nav {
		display: flex;
		align-items: center;
		gap: 1.25rem;
	}
	.link {
		color: var(--dim);
		font-size: 0.9rem;
		text-decoration: none;
		transition: color 0.15s ease;
	}
	.link:hover {
		color: var(--link);
	}
	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.2rem 0.65rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		color: var(--muted);
		font-size: 0.8rem;
		white-space: nowrap;
	}
	.status::before {
		content: '';
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--dim);
	}
	.status.online {
		color: var(--link);
	}
	.status.online::before {
		background: var(--accent-2);
	}
	.status.offline::before {
		background: var(--danger);
	}

	/* Sidebar */
	aside {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		min-height: 0;
		padding: 1rem;
		border-right: 0.5px solid var(--line);
		overflow-y: auto;
	}
	.card {
		padding: 1rem;
		border: 0.5px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--panel);
	}
	h2 {
		margin: 0 0 0.6rem;
		color: var(--dim);
		font-size: 0.75rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	code {
		display: block;
		padding: 0.6rem 0.7rem;
		border: 0.5px solid var(--line);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--link);
		font-size: 0.75rem;
		line-height: 1.5;
		overflow-wrap: anywhere;
		user-select: all;
	}
	.row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.4rem;
	}

	/* Profile and first-run screen */
	.profile {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.2rem 0.2rem 0.9rem;
		border-bottom: 0.5px solid var(--line);
	}
	.list-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
	}
	.head-actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.hidden {
		display: none;
	}
	.searchbar,
	.gsearch {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.45rem 0.8rem;
		border-bottom: 0.5px solid var(--line);
		background: var(--panel);
	}
	.searchbar input,
	.gsearch input {
		flex: 1;
		min-width: 0;
	}
	.searchbar .count {
		min-width: 3.4rem;
		text-align: center;
		font-size: 0.8rem;
		color: var(--muted);
		white-space: nowrap;
	}
	:global(mark) {
		background: color-mix(in srgb, #f2b84b 38%, transparent);
		color: inherit;
		border-radius: 2px;
		padding: 0 0.08em;
	}
	:global(mark.cur) {
		background: #f2b84b;
		color: #1a1200;
		outline: 1.5px solid #f2b84b;
	}
	.gresults {
		overflow-y: auto;
		flex: 1;
		min-height: 0;
	}
	.ggroup h3 {
		margin: 0;
		padding: 0.6rem 0.9rem 0.2rem;
		font-size: 0.78rem;
		letter-spacing: 0.04em;
		color: var(--dim);
	}
	.ggroup ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.ghit {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.15rem;
		width: 100%;
		padding: 0.5rem 0.9rem;
		border: 0;
		border-radius: 0;
		background: transparent;
		text-align: left;
		color: var(--text);
	}
	.ghit:hover {
		background: var(--panel-2);
	}
	.ghit small {
		color: var(--muted);
	}
	.gsnip {
		overflow-wrap: anywhere;
	}
	.list-head h2 {
		margin: 0;
	}
	.list-head button {
		padding: 0.3rem 0.7rem;
		font-size: 0.8rem;
	}
	.empty p {
		margin: 0 0 0.8rem;
	}
	.menu-wrap {
		position: relative;
	}
	.kebab {
		display: grid;
		place-items: center;
		width: 2.2rem;
		height: 2.2rem;
		padding: 0;
	}
	.menu {
		position: absolute;
		top: calc(100% + 0.3rem);
		right: 0;
		z-index: 5;
		min-width: 14rem;
		padding: 0.3rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--panel-2);
	}
	.menu button {
		width: 100%;
		border-color: transparent;
		text-align: left;
		white-space: nowrap;
	}
	.menu button.danger,
	.menu button.danger:hover {
		border: none;
		background: transparent;
		color: var(--danger);
	}
	.menu button.danger:hover {
		background: var(--panel);
	}
	.settings code + button {
		justify-self: start;
	}
	.profile button {
		flex: none;
		padding: 0.3rem 0.7rem;
		font-size: 0.8rem;
	}
	.field {
		display: grid;
		gap: 0.3rem;
		color: var(--muted);
		font-size: 0.8rem;
	}
	.check {
		display: flex;
		align-items: flex-start;
		gap: 0.55rem;
		color: var(--text);
		font-size: 0.85rem;
		cursor: pointer;
	}
	.check input {
		flex: none;
		width: 1rem;
		height: 1rem;
		margin: 0.2rem 0 0;
		padding: 0;
		accent-color: var(--accent);
	}
	.hint {
		margin: 0;
		color: var(--dim);
		font-size: 0.78rem;
	}
	.hint.warn {
		color: var(--link);
	}
	.onboard {
		grid-column: 1 / -1;
		display: grid;
		place-items: center;
		min-height: 0;
		padding: 1.25rem;
		overflow-y: auto;
	}
	.onboard .card {
		display: grid;
		gap: 0.8rem;
		width: 100%;
		max-width: 30rem;
		padding: 1.75rem;
	}
	.onboard h1 {
		margin: 0.3rem 0 0;
		color: var(--heading);
		font-size: 1.5rem;
	}
	.onboard .lead {
		margin: 0 0 0.3rem;
		color: var(--muted);
		font-size: 0.92rem;
	}
	.onboard button {
		padding: 0.7rem 1rem;
	}
	.code-input,
	.code {
		font-size: 1.35rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-align: center;
		text-transform: uppercase;
	}
	.code-input::placeholder {
		font-weight: 400;
	}

	/* Settings */
	.settings {
		display: grid;
		align-content: start;
		justify-items: center;
		gap: 0.9rem;
		min-height: 0;
		padding: 1.25rem;
		overflow-y: auto;
	}
	.settings .card {
		display: grid;
		gap: 0.7rem;
		width: 100%;
		max-width: 40rem;
	}
	.settings h2 {
		margin: 0;
	}
	.devices {
		display: grid;
		gap: 0.4rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.devices li {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.55rem 0.7rem;
		border: 0.5px solid var(--line);
		border-radius: var(--radius);
		background: var(--bg);
	}
	.devices li.empty {
		border-style: dashed;
		background: transparent;
	}
	.devices button {
		flex: none;
		padding: 0.3rem 0.7rem;
		font-size: 0.8rem;
	}
	.link-box {
		display: grid;
		gap: 0.6rem;
		padding: 1rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
	}
	h3 {
		margin: 0;
		color: var(--muted);
		font-size: 0.8rem;
		font-weight: 500;
	}
	.code {
		margin: 0;
		color: var(--heading);
		user-select: all;
	}
	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}
	button.danger:hover:not(:disabled) {
		border-color: var(--danger);
		background: var(--danger);
		color: var(--bg);
	}

	/* Controls */
	button {
		padding: 0.5rem 0.9rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: transparent;
		color: var(--link);
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
		transition:
			background-color 0.2s ease,
			color 0.2s ease,
			border-color 0.2s ease;
	}
	button:hover:not(:disabled) {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-ink);
	}
	button.primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-ink);
	}
	button.primary:hover:not(:disabled) {
		border-color: var(--accent-2);
		background: var(--accent-2);
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	input {
		width: 100%;
		padding: 0.6rem 0.75rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
		font-size: 0.9rem;
		transition: border-color 0.2s ease;
	}
	input::placeholder {
		color: var(--dim);
	}
	input:focus {
		border-color: var(--accent-2);
		outline: none;
	}
	.notice {
		margin: 0;
		padding: 0.6rem 0.75rem;
		border: 0.5px solid var(--line-strong);
		border-left: 2px solid var(--accent-2);
		border-radius: var(--radius);
		background: var(--panel);
		font-size: 0.85rem;
	}

	/* Conversation list */
	.contacts {
		display: grid;
		gap: 0.35rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.contact {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		width: 100%;
		padding: 0.6rem 0.7rem;
		border-color: transparent;
		color: var(--text);
		text-align: left;
	}
	.contact:hover:not(:disabled) {
		border-color: var(--line);
		background: var(--panel);
		color: var(--text);
	}
	.contact.selected,
	.contact.selected:hover {
		border-color: var(--line-strong);
		background: var(--panel-2);
	}
	.avatar {
		display: grid;
		flex: none;
		place-items: center;
		width: 2.3rem;
		height: 2.3rem;
		border: 0.5px solid var(--line-strong);
		border-radius: 50%;
		background: var(--panel-2);
		color: var(--link);
		font-weight: 700;
		text-transform: uppercase;
	}
	.who {
		display: grid;
		flex: 1;
		min-width: 0;
	}
	.who strong {
		color: var(--heading);
		font-size: 0.92rem;
	}
	.who strong,
	.who small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	small {
		color: var(--muted);
		font-size: 0.75rem;
	}
	.ticks {
		display: inline-flex;
		vertical-align: -2px;
		color: var(--muted);
	}
	.ticks.read {
		color: var(--link);
	}
	.when {
		flex: none;
		color: var(--dim);
	}
	.meta {
		display: grid;
		flex: none;
		justify-items: end;
		gap: 0.25rem;
	}
	.marks {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 1.1rem;
	}
	.mute-icon {
		color: var(--dim);
	}
	.badge {
		min-width: 1.2rem;
		padding: 0 0.4rem;
		border-radius: var(--radius);
		background: var(--accent);
		color: var(--accent-ink);
		font-size: 0.7rem;
		font-weight: 700;
		line-height: 1.2rem;
		text-align: center;
	}
	.badge.quiet {
		background: var(--panel-2);
		border: 0.5px solid var(--line-strong);
		color: var(--muted);
		line-height: calc(1.2rem - 1px);
	}
	.notify-banner {
		display: grid;
		gap: 0.6rem;
		margin: 0 0 0.6rem;
		padding: 0.75rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius-lg);
		background: var(--panel);
	}
	.hx-banner {
		display: grid;
		gap: 0.4rem;
		margin: 0 0 0.6rem;
		padding: 0.65rem 0.75rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius-lg);
		background: var(--panel);
	}
	.hx-banner p {
		margin: 0;
		font-size: 0.82rem;
		color: var(--text);
	}
	.hx-bar {
		height: 4px;
		border-radius: 2px;
		background: var(--panel-2);
		overflow: hidden;
	}
	.hx-bar span {
		display: block;
		height: 100%;
		background: var(--accent);
		transition: width 0.3s ease;
	}
	.notify-banner p {
		margin: 0;
		color: var(--text);
		font-size: 0.82rem;
	}
	.notify-banner .row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.verified-mark {
		display: inline-flex;
		margin-left: 0.3rem;
		vertical-align: -0.12em;
		color: var(--accent-2, var(--accent));
	}
	.safety-banner {
		display: grid;
		gap: 0.5rem;
		margin: 0.5rem;
		padding: 0.7rem 0.8rem;
		border: 0.5px solid var(--danger);
		border-radius: var(--radius-lg);
		background: var(--panel);
	}
	.safety-banner p {
		margin: 0;
		font-size: 0.85rem;
	}
	.safety-banner .row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.safety-number {
		display: grid;
		grid-template-columns: repeat(4, auto);
		justify-content: center;
		gap: 0.5rem 1.1rem;
		font-family: var(--mono, ui-monospace, monospace);
		font-size: 1.25rem;
		letter-spacing: 0.06em;
		color: var(--heading);
	}
	.safety-state {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
		justify-content: center;
		color: var(--dim);
		font-size: 0.85rem;
	}
	.safety-state.ok {
		color: var(--accent-2, var(--accent));
	}
	.safety .row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		justify-content: center;
	}
	.warn-box {
		color: var(--danger);
		font-weight: 600;
	}
	.empty {
		color: var(--muted);
		font-size: 0.9rem;
	}

	/* Chat */
	main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.chat-head {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		min-height: 3.6rem;
		padding: 0.7rem 1.25rem;
		border-bottom: 0.5px solid var(--line);
		background: var(--panel);
	}
	.lock {
		padding: 0.2rem 0.65rem;
		border: 0.5px solid var(--line);
		border-radius: var(--radius);
		color: var(--dim);
		font-size: 0.75rem;
		white-space: nowrap;
	}
	.back {
		display: none;
	}
	.messages {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.5rem;
		min-height: 0;
		padding: 1.25rem;
		overflow-y: auto;
	}
	.live-line {
		align-self: flex-start;
		max-width: min(36rem, 85%);
		padding: 0.2rem 0.2rem 0.2rem 0.6rem;
		border-left: 2px solid var(--line);
		color: var(--dim);
		font-size: 0.9rem;
		font-style: italic;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.live-tag {
		display: block;
		font-size: 0.68rem;
		font-style: normal;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		opacity: 0.8;
	}
	.bubble {
		align-self: flex-start;
		max-width: min(36rem, 85%);
		padding: 0.55rem 0.8rem;
		border: 0.5px solid var(--line);
		border-radius: var(--radius-lg);
		border-bottom-left-radius: var(--radius);
		background: var(--panel);
	}
	.bubble.mine {
		align-self: flex-end;
		border-color: var(--line-strong);
		border-radius: var(--radius-lg);
		border-bottom-right-radius: var(--radius);
		background: var(--mine);
	}
	.bubble {
		position: relative;
		transition: background-color 0.3s;
	}
	.bubble.flash {
		background: var(--panel-2);
	}
	.quote {
		display: block;
		width: 100%;
		margin: 0 0 0.35rem;
		padding: 0.25rem 0.5rem;
		border: 0;
		border-left: 3px solid var(--accent-2);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--muted);
		font: inherit;
		font-size: 0.85em;
		text-align: left;
		cursor: pointer;
	}
	.quote strong,
	.quote span,
	.quote-text strong,
	.quote-text span {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.reply-btn {
		position: absolute;
		top: 0.2rem;
		right: 0.3rem;
		display: grid;
		place-items: center;
		min-height: 0;
		padding: 0.25rem;
		border: 0;
		border-radius: var(--radius);
		background: var(--panel);
		color: var(--muted);
		opacity: 0;
		cursor: pointer;
	}
	.act-btn {
		right: 1.9rem;
	}
	.bubble:hover .reply-btn,
	.reply-btn:focus-visible {
		opacity: 1;
	}
	.msg-menu {
		position: fixed;
		min-width: 12rem;
	}
	.blocked-bar button {
		flex: none;
	}
	.replybar {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 1.25rem;
		border-top: 0.5px solid var(--line);
		border-left: 3px solid var(--accent-2);
		background: var(--panel);
		color: var(--muted);
		font-size: 0.85em;
	}
	.quote-text {
		flex: 1;
		min-width: 0;
	}
	.replybar button {
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
	}
	.bubble.failed {
		border-color: var(--danger);
	}
	.bubble p {
		margin: 0 0 0.15rem;
		color: var(--heading);
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.composer {
		display: flex;
		gap: 0.6rem;
		padding: 0.9rem 1.25rem;
		border-top: 0.5px solid var(--line);
		background: var(--panel);
	}
	.composer button {
		padding-inline: 1.4rem;
	}
	.composer .emoji-btn,
	.composer .gif-btn,
	.composer .attach-btn {
		flex: none;
		display: grid;
		place-items: center;
		padding: 0 0.6rem;
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
	}
	.file-input {
		display: none;
	}
	.att-error {
		margin: 0;
		padding: 0.4rem 1.25rem;
		border-top: 0.5px solid var(--danger);
		background: var(--panel);
		color: var(--danger);
		font-size: 0.85em;
	}
	main.dragging {
		outline: 2px dashed var(--accent-2);
		outline-offset: -6px;
	}
	.bubble :global(.att) {
		margin-bottom: 0.3rem;
	}
	.up-box {
		position: relative;
		width: min(18rem, calc(20rem * var(--ratio)), 70vw);
		max-height: 20rem;
		overflow: hidden;
		border-radius: calc(var(--radius-lg) - 4px);
		background: var(--panel-2);
	}
	.up-box img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		filter: blur(10px);
		transform: scale(1.15);
	}
	.up-over {
		position: absolute;
		inset: 0;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 0.4rem;
		padding: 0.6rem;
		background: color-mix(in srgb, var(--panel) 55%, transparent);
		color: var(--heading);
		font-size: 0.85em;
		text-align: center;
	}
	.up-over p {
		margin: 0;
	}
	.up-over progress {
		width: 8rem;
	}
	.up-over button {
		min-height: 0;
		padding: 0.25rem 0.8rem;
		cursor: pointer;
	}
	.up-over .row {
		display: flex;
		gap: 0.4rem;
	}
	.composer .emoji-btn:hover:not(:disabled),
	.composer .gif-btn:hover:not(:disabled),
	.composer .gif-btn[aria-expanded='true'],
	.composer .attach-btn:hover:not(:disabled),
	.composer .emoji-btn[aria-expanded='true'] {
		border: 0;
		background: none;
		color: var(--accent-2);
	}
	.bubble .edited {
		font-style: italic;
	}
	.bubble.emoji-only p {
		font-size: 2.6rem;
		line-height: 1.2;
	}
	.center {
		margin: auto;
		padding: 1rem;
		text-align: center;
	}
	.welcome {
		display: grid;
		justify-items: center;
		gap: 0.4rem;
		max-width: 30rem;
		margin: auto;
		padding: 2rem;
		color: var(--muted);
		text-align: center;
	}
	.welcome h1 {
		margin: 0.8rem 0 0;
		color: var(--heading);
		font-size: 2.2rem;
		letter-spacing: 0.1em;
		line-height: 1;
	}
	.welcome .tagline {
		margin: 0 0 0.8rem;
		color: var(--link);
		font-weight: 600;
	}
	.welcome p {
		margin: 0;
	}

	/* Nothing may be wider than the screen: grid and flex children shrink instead of pushing the page out. */
	.shell > :global(*),
	.top > :global(*) {
		min-width: 0;
	}

	/* Desktop: a fixed two-pane messenger. Nothing scrolls except the list and the message area. */
	.shell.desktop {
		grid-template-columns: 300px minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr);
		height: 100vh;
		overflow: hidden;
	}
	.side {
		display: flex;
		flex-direction: column;
		gap: 0;
		padding: 0;
		border-right: 0.5px solid var(--line);
		background: var(--panel);
		overflow: hidden;
	}
	.side-top,
	.side-bottom {
		display: flex;
		flex: none;
		align-items: center;
		gap: 0.6rem;
		height: 52px;
		padding: 0 0.8rem;
	}
	.side-top {
		border-bottom: 0.5px solid var(--line);
	}
	.side-bottom {
		height: 56px;
		border-top: 0.5px solid var(--line);
	}
	.wordmark {
		flex: 1;
		color: var(--heading);
		font-size: 0.95rem;
		font-weight: 700;
		white-space: nowrap;
	}
	.side-bottom {
		cursor: pointer;
	}
	.side-bottom:hover,
	.side-bottom.on {
		background: var(--panel-2);
	}
	.side .status {
		padding: 0;
		border: none;
		font-size: 0.75rem;
	}
	.side-list {
		flex: 1;
		align-content: start;
		gap: 0;
		min-height: 0;
		overflow-y: auto;
	}
	.side-list .empty {
		display: grid;
		gap: 0.6rem;
		padding: 1rem;
	}
	.side-list .empty p {
		margin: 0;
	}
	.shell.desktop .contact {
		height: 56px;
		padding: 0 0.8rem 0 0.6rem;
		border: none;
		border-left: 2px solid transparent;
		border-radius: 0;
	}
	.shell.desktop .contact:hover:not(:disabled) {
		background: var(--panel-2);
	}
	.shell.desktop .contact.selected,
	.shell.desktop .contact.selected:hover {
		border-left-color: var(--accent);
		background: var(--panel-2);
	}
	.side .notice {
		flex: none;
		margin: 0.5rem 0.8rem;
		font-size: 0.78rem;
	}
	.shell.desktop .icon-btn {
		display: grid;
		flex: none;
		place-items: center;
		width: 2rem;
		height: 2rem;
		padding: 0;
		border-color: transparent;
	}
	.shell.desktop .icon-btn:hover:not(:disabled),
	.shell.desktop .icon-btn.on {
		border-color: transparent;
		background: var(--panel-2);
		color: var(--link);
	}
	.shell.desktop .chat-head {
		flex: none;
		height: 52px;
		min-height: 52px;
		padding: 0 1rem;
	}
	.shell.desktop .chat-head .avatar {
		width: 2rem;
		height: 2rem;
		font-size: 0.85rem;
	}
	.shell.desktop .lock {
		display: none;
	}
	.shell.desktop .settings {
		flex: 1;
	}
	.shell.desktop .welcome {
		gap: 0.8rem;
	}

	/* Desktop: compact, quiet controls in the spirit of macOS apps. Web and mobile keep their sizes. */
	.shell.desktop button:not(.contact) {
		min-height: 0;
		height: 28px;
		padding: 0 0.7rem;
		border-radius: var(--radius);
		font-size: 13px;
		line-height: 1;
	}
	.shell.desktop button.kebab {
		padding: 0;
	}
	.shell.desktop .chat-head .close {
		display: grid;
		place-items: center;
		width: 28px;
		padding: 0;
		border-color: transparent;
		color: var(--muted);
	}
	.shell.desktop .chat-head .close:hover:not(:disabled) {
		background: var(--panel-2);
		color: var(--heading);
		border-color: transparent;
	}
	/* Desktop hover and keyboard focus: flat colour shifts only, 110 ms, no glow or motion. */
	.shell.desktop .contact,
	.shell.desktop .side-bottom,
	.shell.desktop button,
	.shell.desktop .menu button {
		transition:
			background-color 0.11s ease,
			border-color 0.11s ease,
			color 0.11s ease;
	}
	.shell.desktop button:not(.contact):not(.primary):not(.icon-btn):not(.close):not(.danger):hover:not(:disabled) {
		border-color: var(--accent-2);
		background: var(--panel-2);
		color: var(--heading);
	}
	.shell.desktop button.primary:hover:not(:disabled) {
		border-color: var(--accent-2);
		background: var(--accent-2);
		color: var(--accent-ink);
	}
	.shell.desktop button.danger:hover:not(:disabled) {
		border-color: var(--danger);
		background: var(--panel-2);
		color: var(--danger);
	}
	.shell.desktop .menu button:hover:not(:disabled) {
		border-color: transparent;
		background: var(--panel);
		color: var(--heading);
	}
	.shell.desktop .menu button.danger:hover:not(:disabled) {
		border-color: transparent;
		background: var(--panel);
		color: var(--danger);
	}
	.shell.desktop .icon-btn:hover:not(:disabled),
	.shell.desktop .chat-head .close:hover:not(:disabled) {
		border-color: var(--line-strong);
		background: var(--panel-2);
		color: var(--heading);
	}
	.shell.desktop .icon-btn.on {
		border-color: transparent;
		background: var(--panel-2);
	}
	.shell.desktop .side-bottom:hover {
		background: var(--panel-2);
	}
	.shell.desktop .icon-btn.gear {
		width: 30px;
		height: 30px;
		color: var(--muted);
	}
	.shell.desktop .icon-btn.gear svg {
		display: block;
	}
	.shell.desktop .contact:focus-visible,
	.shell.desktop .side-bottom:focus-visible,
	.shell.desktop .menu button:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: -2px;
	}
	.shell.desktop input {
		height: 32px;
		padding: 0 0.65rem;
		border-radius: var(--radius);
		font-size: 13px;
	}
	.shell.desktop .card,
	.shell.desktop .onboard .card {
		padding: 0.85rem 1rem;
		border-radius: var(--radius-lg);
	}
	.shell.desktop .onboard .card {
		padding: 1.4rem;
		gap: 0.7rem;
		justify-items: start;
	}
	.shell.desktop .onboard .card > :global(.logo) {
		width: 44px;
		height: 44px;
	}
	.shell.desktop .onboard .card input {
		justify-self: stretch;
	}
	.shell.desktop .onboard button {
		padding: 0 0.8rem;
	}
	.shell.desktop .settings {
		gap: 0.7rem;
		padding: 1rem;
	}
	.shell.desktop .settings .card {
		justify-items: start;
		gap: 0.6rem;
	}
	.shell.desktop .settings .card > :global(*) {
		max-width: 100%;
	}
	.shell.desktop .settings .card :is(code, input, .devices, .link-box, .notice, .hint, p) {
		justify-self: stretch;
	}
	.shell.desktop .row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.shell.desktop .devices button {
		padding: 0 0.6rem;
		font-size: 12px;
		height: 26px;
	}
	.shell.desktop .side-list .empty {
		justify-items: start;
	}
	.shell.desktop .menu button {
		height: auto;
		min-height: 28px;
		padding: 0.4rem 0.7rem;
	}
	.seg {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.4rem;
	}
	.seg.seg-wide {
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
	}
	.seg button[aria-pressed='true'] {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-ink);
	}
	.lang-row {
		justify-self: start;
	}
	.about-name {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0;
		color: var(--heading);
	}
	.about-links {
		grid-template-columns: repeat(3, auto);
		justify-content: start;
	}
	.onboard-lang {
		position: fixed;
		top: 0.75rem;
		right: 0.75rem;
	}
	.ctx {
		position: fixed;
		right: auto;
		min-width: 12rem;
		z-index: 90;
	}

	/* Icon buttons: 44 px hit area, same on web, mobile and desktop. */
	.shell button.ibtn.ibtn {
		display: inline-grid;
		flex: none;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		min-height: 2.75rem;
		padding: 0;
		border-color: transparent;
		border-radius: var(--radius);
		background: transparent;
		color: var(--muted);
		font-size: inherit;
	}
	.shell button.ibtn.ibtn:hover:not(:disabled),
	.shell button.ibtn.ibtn.on {
		border-color: transparent;
		background: var(--panel-2);
		color: var(--heading);
	}
	.shell button.ibtn.ibtn.primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-ink);
	}
	.shell button.ibtn.ibtn.primary:hover:not(:disabled) {
		border-color: var(--accent-2);
		background: var(--accent-2);
		color: var(--accent-ink);
	}
	.shell button.ibtn.ibtn:disabled {
		opacity: 0.4;
	}
	.shell button.ibtn.ibtn.back {
		display: none;
	}
	.shell button.ibtn.ibtn.gear {
		width: 2.5rem;
		height: 2.5rem;
		min-height: 2.5rem;
	}
	.shell .composer button.send-btn {
		padding: 0;
		align-self: flex-end;
	}
	.menu button {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.menu button :global(.icon) {
		color: var(--muted);
	}
	.menu button.danger :global(.icon) {
		color: inherit;
	}
	.shell .replybar:not(.blocked-bar) > button {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		min-height: 2.5rem;
		padding: 0;
		border-color: transparent;
	}
	.shell .reply-btn {
		min-width: 2rem;
		min-height: 2rem;
	}

	/* v0.8 consistency pass: one button, one icon size, one heading style, one spacing rhythm. */
	.with-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}
	.settings .card > .with-icon,
	.settings .card > code + .with-icon {
		justify-self: start;
	}
	.settings .card > form .with-icon {
		justify-self: start;
	}
	h3 {
		color: var(--dim);
		font-size: 0.75rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.who.title {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.who.title :global(.icon) {
		color: var(--dim);
	}
	.chat-head .who.title strong {
		font-size: 0.92rem;
	}
	/* Sub screens (settings, new conversation, safety number): a single bar, not three. */
	.shell.sub:not(.desktop) .top {
		display: none;
	}
	.shell.sub:not(.desktop) {
		grid-template-rows: minmax(0, 1fr);
	}
	/* Buttons in a row are equal in width, the last odd one spans. Same on every platform. */
	.row,
	.shell.desktop .row,
	.notify-banner .row,
	.safety-banner .row,
	.safety .row {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}
	.row > :global(button:only-child),
	.row > :global(button:first-child:nth-last-child(3)) {
		grid-column: 1 / -1;
	}
	.up-over .row {
		display: flex;
	}
	.about-links,
	.shell.desktop .about-links {
		grid-template-columns: repeat(3, auto);
		justify-content: start;
	}
	.empty-box {
		margin: auto;
		padding: 1rem 1.25rem;
		border: 0.5px dashed var(--line-strong);
		border-radius: var(--radius-lg);
		color: var(--muted);
		font-size: 0.85rem;
		text-align: center;
	}
	.devices li.empty {
		border-color: var(--line-strong);
		color: var(--muted);
	}
	/* Bubble footer: time and actions share a line below the text, never on top of it. */
	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-height: 1.1rem;
	}
	.acts {
		display: inline-flex;
		gap: 0.1rem;
		margin: -0.5rem -0.4rem -0.5rem 0;
	}
	.shell .bubble .reply-btn {
		position: static;
		min-width: 1.75rem;
		min-height: 1.75rem;
		padding: 0.25rem;
		background: transparent;
	}
	.shell .bubble .reply-btn:hover {
		background: var(--panel-2);
		color: var(--heading);
	}
	.bubble:focus-within .reply-btn {
		opacity: 1;
	}
	.bubble.mine small,
	.bubble.mine .ticks {
		color: color-mix(in srgb, var(--text) 70%, transparent);
	}
	.bubble.mine .ticks.read {
		color: var(--accent-2);
	}
	.bubble p :global(a),
	.bubble p a {
		color: var(--link);
		text-decoration: underline;
		text-underline-offset: 2px;
		overflow-wrap: anywhere;
	}
	.bubble.mine p a {
		color: var(--heading);
	}
	/* Composer: grows to a few lines, then scrolls. */
	.composer {
		align-items: flex-end;
	}
	.composer-input {
		flex: 1;
		min-width: 0;
		min-height: 2.75rem;
		max-height: 9rem;
		padding: 0.6rem 0.75rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
		font-size: 0.9rem;
		line-height: 1.5rem;
		resize: none;
		overflow-y: auto;
	}
	.composer-input::placeholder {
		color: var(--dim);
	}
	.composer-input:focus {
		border-color: var(--accent-2);
		outline: none;
	}
	.shell .composer .attach-btn,
	.shell .composer .emoji-btn,
	.shell .composer .gif-btn {
		height: 2.75rem;
		min-height: 2.75rem;
	}
	.shell.desktop .composer-input {
		min-height: 32px;
		padding: 0.3rem 0.65rem;
		font-size: 13px;
		line-height: 20px;
	}
	.shell.desktop .composer .attach-btn,
	.shell.desktop .composer .emoji-btn,
	.shell.desktop .composer .gif-btn {
		height: 32px;
		min-height: 32px;
	}
	.notify-banner button {
		width: 100%;
	}
	.notify-banner .row,
	.shell.desktop .notify-banner .row {
		grid-template-columns: minmax(0, 1fr);
	}
	.composer {
		gap: 0.3rem;
	}
	.shell .composer .attach-btn,
	.shell .composer .emoji-btn,
	.shell .composer .gif-btn {
		padding: 0 0.4rem;
	}
	.composer-input {
		overflow-y: hidden;
	}

	@media (max-width: 760px) {
		.shell:not(.desktop) {
			grid-template-columns: minmax(0, 1fr);
		}
		.shell:not(.desktop) .top {
			gap: 0.5rem;
			padding: 0 0.75rem;
		}
		.shell:not(.desktop) nav {
			gap: 0.5rem;
		}
		/* The dot carries the state; the word comes back on wider screens. */
		.shell:not(.desktop) .status {
			font-size: 0;
			gap: 0;
			padding: 0.4rem;
		}
		/* Comfortable touch targets, and 16px inputs so phones do not zoom in on focus. */
		.shell:not(.desktop) :global(button),
		.shell:not(.desktop) :global(.btn) {
			min-height: 2.75rem;
		}
		.shell:not(.desktop) :global(input),
		.shell:not(.desktop) :global(textarea),
		.shell:not(.desktop) :global(select) {
			font-size: 16px;
		}
		.shell:not(.desktop) .composer {
			padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
		}
		.shell.chat-open:not(.desktop) aside,
		.shell:not(.chat-open):not(.desktop) main {
			display: none;
		}
		.shell:not(.desktop) button.ibtn.ibtn.back {
			display: inline-grid;
		}
		.shell:not(.desktop) button.ibtn.ibtn.close {
			display: none;
		}
		.shell:not(.desktop) .link,
		.shell:not(.desktop) .lock,
		.shell:not(.desktop) .close {
			display: none;
		}
	}
</style>
