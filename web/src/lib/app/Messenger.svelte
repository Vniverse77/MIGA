<script lang="ts">
	import { platform } from '../platform';
import ConfirmDialog, { ask, askText } from './ConfirmDialog.svelte';
	import QrCode from './QrCode.svelte';
	import Scanner from './Scanner.svelte';
	import { appUrl, type Scanned } from '../qr';
	import { VERSION_LABEL, VERSION_TITLE } from '../version';
	import { onMount, tick } from 'svelte';
	import {
		bytesToHex,
		cleanReply,
		decrypt,
		encrypt,
		encryptDelete,
		hexToBytes,
		identityFromSecret,
		isAddress,
		randomId,
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
		historyChunks,
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
	import logo from '../assets/favicon.svg';
	import { t } from '../i18n.svelte';
	import LangSelect from '../LangSelect.svelte';
	import { RelayClient, type Incoming, type RelayEvents, type Status } from '../relay';
	import {
		MAX_BLOCKED,
		createIdentity,
		eraseAll,
		loadBlocked,
		loadChats,
		loadContacts,
		loadDevice,
		loadDevices,
		loadIdentity,
		loadOpenLink,
		loadProfile,
		saveBlocked,
		saveChats,
		saveContacts,
		saveDevices,
		saveIdentity,
		saveOpenLink,
		saveProfile,
		type Chats,
		type Contact,
		type Device,
		type Message,
		type Profile
	} from '../storage';

	const MAX_TEXT = 4000;
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
	let active = $state<string | null>(null);
	let view = $state<'chat' | 'settings' | 'new'>('chat');
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
	let composerInput = $state<HTMLInputElement | null>(null);
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
	let scanning = $state<'link' | 'to' | null>(null);

	// "Add a device" on a device that already has the account
	let link = $state<{ code: string } | null>(null);
	let linkNotice = $state('');
	let deviceLabel = $state('');

	// Not reactive: connections and keys.
	let relay: RelayClient | null = null;
	let deviceRelay: RelayClient | null = null;
	let device: Identity | null = null;
	let sync: Uint8Array | null = null;
	let linkMailbox: Identity | null = null;
	let linkTimer: ReturnType<typeof setTimeout> | undefined;
	let outboxTimer: ReturnType<typeof setInterval> | undefined;
	const outbox: { to: string; id: string; body: string }[] = [];

	const activeContact = $derived(contacts.find((c) => c.address === active) ?? null);
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
		contacts = loadContacts();
		chats = loadChats();
		profile = loadProfile();
		blocked = loadBlocked();
		deviceLabel = guessDeviceLabel();
		readInvite();
		const me = loadIdentity();
		if (me) start(me);
		notice = startNotice;
		ready = true;
		return () => {
			relay?.close();
			deviceRelay?.close();
			clearInterval(outboxTimer);
			clearTimeout(linkTimer);
		};
	});

	/** Opens two connections: one as the account, one as this device (for sync between devices). */
	function start(me: Identity): void {
		identity = me;
		device = loadDevice();
		devices = loadDevices();
		sync = syncKey(me);

		relay = new RelayClient(relayUrl(), me, {
			onStatus: (s) => (status = s),
			onReady: () => resendPending(me),
			onMessage: (m) => {
				// Blocked: acknowledged (the relay deletes it) and dropped without a trace.
				if (blocked.includes(m.from)) return true;
				const plain = decrypt(me, m.from, m.body);
				// Anything we cannot open is acknowledged too, so it does not clog the queue.
				if (!plain) return true;
				// A delete request: only messages that came from this very sender can go.
				if (plain.del) {
					const items = plain.del.map((id) => ({ id, mine: false }));
					const list = chats[m.from];
					if (list && removeMessages(list, items)) {
						persist();
						syncAll({ k: 'del', peer: m.from, items });
					}
					return true;
				}
				// A shared name is only a label chosen by the sender; the address stays the identity.
				ensureContact(m.from, plain.name);
				const message: Message = {
					id: m.id,
					mine: false,
					text: plain.text.slice(0, MAX_TEXT),
					ts: m.ts,
					state: 'received',
					...(plain.reply ? { reply: plain.reply } : {})
				};
				// Every online device gets the message from the relay; offline ones get this copy.
				if (addMessages(m.from, [message])) {
					syncAll({ k: 'msg', peer: m.from, message, name: plain.name });
				}
				persist();
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

		deviceRelay = new RelayClient(relayUrl(), device, { ...quiet, onMessage: onSyncMessage });
		deviceRelay.connect();
		outboxTimer = setInterval(pumpOutbox, OUTBOX_MS);
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
					const known = contacts.find((c) => c.address === contact.address);
					if (known) Object.assign(known, { name: contact.name, custom: contact.custom });
					else contacts.push(contact);
				}
				if (message.blocked !== undefined) {
					blocked = cleanBlocked(message.blocked, identity?.address);
					saveBlocked($state.snapshot(blocked));
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
				for (const [peer, list] of Object.entries(message.chats ?? {})) {
					if (!isAddress(peer) || !Array.isArray(list)) continue;
					const clean = list.map((x) => cleanMessage(x, MAX_TEXT)).filter((x) => x !== null);
					ensureContact(peer);
					addMessages(peer, clean);
				}
				persist();
				break;
			}
			case 'msg': {
				const clean = cleanMessage(message.message, MAX_TEXT);
				if (!clean || !isAddress(message.peer)) break;
				ensureContact(message.peer, clean.mine ? undefined : message.name);
				addMessages(message.peer, [clean]);
				persist();
				break;
			}
			case 'del': {
				if (!isAddress(message.peer)) break;
				const list = chats[message.peer];
				if (list && removeMessages(list, cleanDeleteItems(message.items))) persist();
				break;
			}
			case 'bye': {
				if (message.address === device.address) {
					// Another device removed this one: leave no trace here. The short delay lets the
					// acknowledgement reach the relay, so the notice is not kept there.
					setTimeout(() => {
						eraseAll();
						location.reload();
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
		for (let i = 0; i < all.length; i += 50) {
			syncSend(to, { k: 'state', contacts: all.slice(i, i + 50) });
		}
		for (const chunk of historyChunks($state.snapshot(chats))) {
			syncSend(to, { k: 'history', chats: chunk });
		}
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
		setTimeout(() => {
			eraseAll();
			location.reload();
		}, 400);
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
		scroller?.scrollTo(0, scroller.scrollHeight);
	});

	function persist(): void {
		saveContacts($state.snapshot(contacts));
		saveChats($state.snapshot(chats));
	}

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
					relay?.send(address, m.id, encrypt(me, address, m.text, sharedName, m.reply));
				}
			}
		}
	}

	function sendMessage(event: SubmitEvent): void {
		event.preventDefault();
		const text = draft.trim();
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

	function openChat(address: string): void {
		replyTo = null;
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
		persist();
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
		persist();
		if (active === address) active = null;
	}

	function openMsgMenu(x: number, y: number, message: Message): void {
		// Keep the menu inside the window.
		msgMenu = {
			x: Math.max(8, Math.min(x, window.innerWidth - 220)),
			y: Math.max(8, Math.min(y, window.innerHeight - 140)),
			message,
			at: Date.now()
		};
		tick().then(() => msgMenuEl?.querySelector<HTMLElement>('button')?.focus());
	}

	async function deleteForMe(message: Message): Promise<void> {
		msgMenu = null;
		if (!active) return;
		const peer = active;
		const ok = await ask({ body: t('q_delete_me'), confirm: t('delete_msg_me'), danger: true });
		if (!ok) return;
		const items = [{ id: message.id, mine: message.mine }];
		if (chats[peer] && removeMessages(chats[peer], items)) persist();
		syncAll({ k: 'del', peer, items });
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
		const items = [{ id: message.id, mine: true }];
		if (chats[peer] && removeMessages(chats[peer], items)) persist();
		syncAll({ k: 'del', peer, items });
	}

	function startReply(message: Message): void {
		if (!active || !identity) return;
		const preview = cleanReply({
			id: message.id,
			from: message.mine ? identity.address : active,
			text: message.text
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
	const timeOf = (ts: number) =>
		new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	const dateOf = (ts: number) => new Date(ts).toLocaleDateString();
	const stateLabel = (state: Message['state']) =>
		state === 'received' ? '' : t(`state_${state}`);
</script>

<svelte:head>
	<title>MIGA</title>
</svelte:head>

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

<div class="shell" class:desktop={isDesktop} class:chat-open={active !== null || view !== 'chat'}>
	{#if !isDesktop}
	<header class="top">
		{#if platform.target === 'web'}
			<a class="brand" href="/">
				<img src={logo} alt="" width="30" height="30" />
				<span>MIGA</span>
				<span class="ver" title={VERSION_TITLE}>{VERSION_LABEL}</span>
			</a>
		{:else}
			<span class="brand">
				<img src={logo} alt="" width="30" height="30" />
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
					<img src={logo} alt="" width="56" height="56" />
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
					<img src={logo} alt="" width="56" height="56" />
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
					<button type="button" disabled={linking} onclick={() => (scanning = 'link')}>{t('scan_button')}</button>
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
				<img src={logo} alt="" width="24" height="24" />
				<span class="wordmark">MIGA</span>
				<span class="status {status}">{t(`status_${status}`)}</span>
				<button type="button" class="icon-btn" title={t('new_conversation')} aria-label={t('new_conversation')} onclick={openNew}>
					<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
						<path d="M12 5v14M5 12h14" />
					</svg>
				</button>
			</div>

			<ul class="contacts side-list">
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
								<strong>{contact.name}</strong>
								<small>{last ? last.text : shortAddress(contact.address)}</small>
							</span>
							{#if last}<small class="when">{timeOf(last.ts)}</small>{/if}
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
					class="icon-btn gear"
					class:on={view === 'settings'}
					title={t('settings')}
					aria-label={t('settings')}
					onclick={(e) => (e.stopPropagation(), toggleSettings())}
				>
					<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">
						<g transform="translate(12 12) scale(1.15) translate(-12 -12)" stroke-width="1.5">
							<path d="M10.3 2.8h3.4l.5 2.4a7.4 7.4 0 0 1 1.7 1l2.3-.8 1.7 2.9-1.8 1.6a7.6 7.6 0 0 1 0 2l1.8 1.6-1.7 2.9-2.3-.8a7.4 7.4 0 0 1-1.7 1l-.5 2.4h-3.4l-.5-2.4a7.4 7.4 0 0 1-1.7-1l-2.3.8-1.7-2.9 1.8-1.6a7.6 7.6 0 0 1 0-2L4.1 8.3l1.7-2.9 2.3.8a7.4 7.4 0 0 1 1.7-1z" />
							<circle cx="12" cy="12" r="3" />
						</g>
					</svg>
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
				<button type="button" onclick={() => (view = view === 'settings' ? 'chat' : 'settings')}>
					{t('settings')}
				</button>
			</div>

			<div class="list-head">
				<h2>{t('chats')}</h2>
				<button type="button" class="primary" onclick={openNew}>{t('new_conversation')}</button>
			</div>

			{#if notice && view === 'chat'}
				<p class="notice" role="status">{notice}</p>
			{/if}

			<ul class="contacts">
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
								<strong>{contact.name}</strong>
								<small>{last ? last.text : shortAddress(contact.address)}</small>
							</span>
							{#if last}<small class="when">{timeOf(last.ts)}</small>{/if}
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

		<main>
			{#if view === 'settings'}
				<header class="chat-head">
					<button type="button" class="back" onclick={() => (view = 'chat')}>← {t('back')}</button>
					<div class="who"><strong>{t('settings')}</strong></div>
					<button type="button" class="close" aria-label={t('close')} title={t('close')} onclick={() => (view = 'chat')}>
						{#if isDesktop}
							<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
						{:else}{t('close')}{/if}
					</button>
				</header>

				<div class="settings">
					<section class="card">
						<h2>{t('your_address')}</h2>
						<code class="selectable">{identity?.address ?? '…'}</code>
						<button type="button" class={isDesktop ? '' : 'primary'} onclick={copyAddress}>{t('copy_address')}</button>
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
									<button type="button" onclick={() => removeDevice(other.address)}>
										{t('dev_remove')}
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
							<button type="button" class="primary" onclick={addDevice}>{t('dev_add')}</button>
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

{#if isDesktop}
						<section class="card">
							<h2>{t('language')}</h2>
							<div class="lang-row"><LangSelect /></div>
						</section>
					{/if}

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
					<button type="button" class="back" onclick={() => (view = 'chat')}>← {t('back')}</button>
					<div class="who"><strong>{t('new_conversation')}</strong></div>
					<button type="button" class="close" aria-label={t('close')} title={t('close')} onclick={() => (view = 'chat')}>
						{#if isDesktop}
							<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
						{:else}{t('close')}{/if}
					</button>
				</header>

				<div class="settings">
					<form class="card" onsubmit={addContact}>
						<h2>{t('new_conversation')}</h2>
						<input bind:value={newAddress} placeholder={t('ph_address')} autocomplete="off" spellcheck="false" />
						<input bind:value={newName} placeholder={t('ph_name')} autocomplete="off" maxlength="40" />
						<button type="submit" class="primary">{t('start_chat')}</button>
						<button type="button" onclick={() => (scanning = 'to')}>{t('scan_button')}</button>
						{#if notice}<p class="notice" role="status">{notice}</p>{/if}
					</form>

					<section class="card">
						<h2>{t('your_address')}</h2>
						<code class="selectable">{identity?.address ?? '…'}</code>
						<button type="button" onclick={copyAddress}>{t('copy_address')}</button>
					</section>
				</div>
			{:else if activeContact}
				<header class="chat-head">
					<button type="button" class="back" onclick={() => (active = null)}>← {t('back')}</button>
					<span class="avatar" aria-hidden="true">{initial(activeContact.name)}</span>
					<div class="who">
						<strong>{activeContact.name}</strong>
<small class="selectable">{shortAddress(activeContact.address)}</small>
					</div>
					<span class="lock">{t('f1_title')}</span>
					<div class="menu-wrap">
						<button
							type="button"
							class="kebab"
							aria-label={t('chat_menu')}
							aria-haspopup="menu"
							aria-expanded={menuOpen}
							onclick={() => (menuOpen = !menuOpen)}
						>
							<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
								<circle cx="12" cy="5" r="2" />
								<circle cx="12" cy="12" r="2" />
								<circle cx="12" cy="19" r="2" />
							</svg>
						</button>
						{#if menuOpen}
							<div class="menu" role="menu">
								<button
									type="button"
									role="menuitem"
									class="danger"
									onclick={() => deleteConversation(activeContact.address)}
								>
									{t('delete_chat')}
								</button>
								<button
									type="button"
									role="menuitem"
									class="danger"
									onclick={() => deleteContact(activeContact.address)}
								>
									{t('delete_contact')}
								</button>
								<button
									type="button"
									role="menuitem"
									class={blocked.includes(activeContact.address) ? '' : 'danger'}
									onclick={() => toggleBlock(activeContact.address)}
								>
									{t(blocked.includes(activeContact.address) ? 'unblock' : 'block')}
								</button>
							</div>
						{/if}
					</div>
				</header>

				<div class="messages" bind:this={scroller}>
					{#each activeMessages as message (message.mine + message.id)}
						<div
							class="bubble"
							class:mine={message.mine}
							class:failed={message.state === 'failed'}
							class:flash={highlighted === (message.mine ? 'm' : 't') + message.id}
							data-key={(message.mine ? 'm' : 't') + message.id}
							role="group"
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
							<p class="selectable">{message.text}</p>
							<small>
								{timeOf(message.ts)}{#if message.mine}{' · ' + stateLabel(message.state)}{/if}
							</small>
							<button
								type="button"
								class="reply-btn"
								aria-label={t('reply')}
								title={t('reply')}
								onclick={() => startReply(message)}
							>
								<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<path d="M9 14 4 9l5-5" />
									<path d="M4 9h10a6 6 0 0 1 6 6v3" />
								</svg>
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
								<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor">
									<circle cx="5" cy="12" r="2" />
									<circle cx="12" cy="12" r="2" />
									<circle cx="19" cy="12" r="2" />
								</svg>
							</button>
						</div>
					{:else}
						<p class="empty center">{t('no_messages')}</p>
					{/each}
				</div>

				{#if replyTo}
					<div class="replybar">
						<div class="quote-text">
							<strong>{t('replying_to', { name: quoteName(replyTo.from) })}</strong>
							<span>{replyTo.text}</span>
						</div>
						<button type="button" aria-label={t('cancel_reply')} title={t('cancel_reply')} onclick={() => (replyTo = null)}>✕</button>
					</div>
				{/if}
				{#if blocked.includes(activeContact.address)}
					<div class="replybar blocked-bar">
						<div class="quote-text"><span>{t('blocked_banner')}</span></div>
						<button type="button" onclick={() => toggleBlock(activeContact.address)}>{t('unblock')}</button>
					</div>
				{:else}
				<form class="composer" onsubmit={sendMessage}>
					<input bind:this={composerInput} bind:value={draft} placeholder={t('ph_message')} autocomplete="off" maxlength={MAX_TEXT} />
					<button type="submit" class="primary" disabled={!draft.trim()}>{t('send')}</button>
				</form>
				{/if}
			{:else}
<div class="welcome">
					{#if !isDesktop}
						<img src={logo} alt="" width="72" height="72" />
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
		<button type="button" role="menuitem" class="danger" onclick={() => ctx && deleteConversation(ctx.address)}>
			{t('delete_chat')}
		</button>
		<button type="button" role="menuitem" class="danger" onclick={() => ctx && deleteContact(ctx.address)}>
			{t('delete_contact')}
		</button>
		<button type="button" role="menuitem" onclick={() => ctx && toggleBlock(ctx.address)}>
			{t(ctx && blocked.includes(ctx.address) ? 'unblock' : 'block')}
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
		<button type="button" role="menuitem" onclick={() => ((msgMenu = null), startReply(target))}>
			{t('reply')}
		</button>
		<button type="button" role="menuitem" class="danger" onclick={() => deleteForMe(target)}>
			{t('delete_msg_me')}
		</button>
		{#if target.mine}
			<button type="button" role="menuitem" class="danger" onclick={() => deleteForEveryone(target)}>
				{t('delete_msg_all')}
			</button>
		{/if}
	</div>
{/if}

<ConfirmDialog />
{#if scanning}
	<Scanner accept={scanning} onresult={scanned} onclose={() => (scanning = null)} />
{/if}

<svelte:window
	onkeydown={(e) => e.key === 'Escape' && ((menuOpen = false), (ctx = null), (msgMenu = null), (replyTo = null))}
	onclick={(e) => {
		ctx = null;
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
	.brand img {
		display: block;
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
		color: var(--accent-2);
	}
	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.2rem 0.65rem;
		border: 0.5px solid var(--line-strong);
		border-radius: 999px;
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
		color: var(--accent-2);
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
		color: var(--accent-2);
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
		color: var(--accent-2);
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
		color: var(--accent-2);
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
		color: var(--accent-2);
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
	.when {
		flex: none;
		color: var(--dim);
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
		border-radius: 999px;
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
	.bubble {
		align-self: flex-start;
		max-width: min(36rem, 85%);
		padding: 0.55rem 0.8rem;
		border: 0.5px solid var(--line);
		border-radius: var(--radius-lg);
		border-bottom-left-radius: 3px;
		background: var(--panel);
	}
	.bubble.mine {
		align-self: flex-end;
		border-color: var(--line-strong);
		border-radius: var(--radius-lg);
		border-bottom-right-radius: 3px;
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
		border-radius: 4px;
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
		border-radius: 6px;
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
		color: var(--accent-2);
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
		color: var(--accent-2);
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
		border-radius: 6px;
		font-size: 13px;
		line-height: 1;
	}
	.shell.desktop button.icon-btn,
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
	.shell.desktop .side-bottom .icon-btn:hover:not(:disabled) {
		background: var(--panel);
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
		border-radius: 6px;
		font-size: 13px;
	}
	.shell.desktop .card,
	.shell.desktop .onboard .card {
		padding: 0.85rem 1rem;
		border-radius: 8px;
	}
	.shell.desktop .onboard .card {
		padding: 1.4rem;
		gap: 0.7rem;
		justify-items: start;
	}
	.shell.desktop .onboard .card > img {
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
		.shell:not(.desktop) .back {
			display: block;
		}
		.shell:not(.desktop) .link,
		.shell:not(.desktop) .lock,
		.shell:not(.desktop) .close {
			display: none;
		}
	}
</style>
