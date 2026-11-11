<script lang="ts">
	import { platform } from '../../lib/platform';
	import { VERSION_LABEL, VERSION_TITLE } from '../../lib/version';
	import { onMount } from 'svelte';
	import {
		bytesToHex,
		decrypt,
		encrypt,
		hexToBytes,
		identityFromSecret,
		isAddress,
		randomId,
		type Identity
	} from '../../lib/crypto';
	import {
		LINK_TTL_MS,
		cleanContact,
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
		seal,
		syncKey,
		type LinkBundle,
		type SyncMessage
	} from '../../lib/devices';
	import logo from '../../lib/assets/favicon.svg';
	import { t } from '../../lib/i18n.svelte';
	import LangSelect from '../../lib/LangSelect.svelte';
	import { RelayClient, type Incoming, type RelayEvents, type Status } from '../../lib/relay';
	import {
		createIdentity,
		eraseAll,
		loadChats,
		loadContacts,
		loadDevice,
		loadDevices,
		loadIdentity,
		loadOpenLink,
		loadProfile,
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
	} from '../../lib/storage';

	const MAX_TEXT = 4000;
	/** Sync traffic is paced to stay well under the relay's limit of 30 sends per 10 seconds. */
	const OUTBOX_MS = 400;
	const LINK_WAIT_MS = 30_000;

	let identity = $state.raw<Identity | null>(null);
	let status = $state<Status>('offline');
	let contacts = $state<Contact[]>([]);
	let chats = $state<Chats>({});
	let profile = $state<Profile>({ name: '', share: true });
	let devices = $state<Device[]>([]);
	let active = $state<string | null>(null);
	let view = $state<'chat' | 'settings'>('chat');
	let ready = $state(false);
	let draft = $state('');
	let newAddress = $state('');
	let newName = $state('');
	let notice = $state('');
	let scroller = $state<HTMLElement | null>(null);

	// First-run screen
	let onboard = $state<'create' | 'link'>('create');
	let codeInput = $state('');
	let linking = $state(false);

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
		const address = (params.get('to') ?? '').trim().toLowerCase();
		if (!isAddress(address)) return;
		invite = { address, name: (params.get('name') ?? '').trim().slice(0, 40) };
		history.replaceState(null, '', location.pathname + location.search);
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
		deviceLabel = guessDeviceLabel();
		readInvite();
		const me = loadIdentity();
		if (me) start(me);
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
				const plain = decrypt(me, m.from, m.body);
				// Anything we cannot open is acknowledged too, so it does not clog the queue.
				if (!plain) return true;
				// A shared name is only a label chosen by the sender; the address stays the identity.
				ensureContact(m.from, plain.name);
				const message: Message = {
					id: m.id,
					mine: false,
					text: plain.text.slice(0, MAX_TEXT),
					ts: m.ts,
					state: 'received'
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
			linkNotice = t('dev_offline');
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

	function removeDevice(address: string): void {
		if (!confirm(t('q_dev_remove'))) return;
		// The removed device is told too: it erases itself the next time it connects.
		syncAll({ k: 'bye', address });
		linkNotice = '';
		devices = devices.filter((d) => d.address !== address);
		saveDevices($state.snapshot(devices));
	}

	function eraseThisDevice(): void {
		if (!confirm(t('q_erase'))) return;
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

		const client = new RelayClient(relayUrl(), mailbox, {
			...quiet,
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
		setTimeout(() => {
			if (done) return;
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
					relay?.send(address, m.id, encrypt(me, address, m.text, sharedName));
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
		chats[active].push({ id, mine: true, text, ts: Date.now(), state: 'pending' });
		persist();
		draft = '';
		// When offline it stays "pending" and is sent on the next connection.
		relay?.send(active, id, encrypt(identity, active, text, sharedName));
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
		if (!confirm(t('q_backup'))) return;
		try {
			await navigator.clipboard.writeText(bytesToHex(identity.secret));
			notice = t('n_key_copied');
		} catch {
			notice = t('n_key_copy_failed');
		}
	}

	function restoreKey(): void {
		const value = prompt(t('q_restore_prompt'))?.trim().toLowerCase();
		if (!value) return;
		if (!/^[0-9a-f]{64}$/.test(value)) {
			notice = t('n_bad_key');
			return;
		}
		if (identity && !confirm(t('q_restore_confirm'))) return;
		saveIdentity(identityFromSecret(hexToBytes(value)));
		// The device list belongs to the account that is being replaced.
		saveDevices([]);
		location.reload();
	}

	function openChat(address: string): void {
		view = 'chat';
		active = address;
	}

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

<div class="shell" class:chat-open={active !== null || view === 'settings'}>
	<header class="top">
		<a class="brand" href="/">
			<img src={logo} alt="" width="30" height="30" />
			<span>MIGA</span>
			<span class="ver" title={VERSION_TITLE}>{VERSION_LABEL}</span>
		</a>
		<nav aria-label="Main">
			<a class="link" href="https://vniverse77.com/">Vniverse77</a>
			<a class="link" href="https://forum.vniverse77.com/">Forum</a>
			<span class="status {status}">{t(`status_${status}`)}</span>
			<LangSelect />
		</nav>
	</header>

	{#if ready && !identity}
		<div class="onboard">
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
					<button type="button" disabled={linking} onclick={() => ((onboard = 'create'), (notice = ''))}>
						← {t('back')}
					</button>
					{#if notice}<p class="notice" role="status">{notice}</p>{/if}
				</form>
			{/if}
		</div>
	{:else}
		<aside>
			<section class="card">
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
				<h2>{t('your_address')}</h2>
				<code>{identity?.address ?? '…'}</code>
				<button type="button" class="primary wide" onclick={copyAddress}>{t('copy_address')}</button>
			</section>

			<form class="card add" onsubmit={addContact}>
				<h2>{t('new_conversation')}</h2>
				<input bind:value={newAddress} placeholder={t('ph_address')} autocomplete="off" spellcheck="false" />
				<input bind:value={newName} placeholder={t('ph_name')} autocomplete="off" maxlength="40" />
				<button type="submit" class="primary">{t('start_chat')}</button>
			</form>

			{#if notice}
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
					<li class="empty">{t('no_conversations')}</li>
				{/each}
			</ul>
		</aside>

		<main>
			{#if view === 'settings'}
				<header class="chat-head">
					<button type="button" class="back" onclick={() => (view = 'chat')}>← {t('back')}</button>
					<div class="who"><strong>{t('settings')}</strong></div>
					<button type="button" class="close" onclick={() => (view = 'chat')}>{t('close')}</button>
				</header>

				<div class="settings">
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
								<p class="code">{formatLinkCode(link.code)}</p>
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
						<h2>{t('set_key')}</h2>
						<p class="hint">{t('set_key_help')}</p>
						<div class="row">
							<button type="button" onclick={backupKey}>{t('backup_key')}</button>
							<button type="button" onclick={restoreKey}>{t('restore')}</button>
						</div>
					</section>

					<section class="card">
						<h2>{t('set_erase')}</h2>
						<p class="hint">{t('set_erase_help')}</p>
						<button type="button" class="danger" onclick={eraseThisDevice}>{t('erase')}</button>
					</section>
				</div>
			{:else if activeContact}
				<header class="chat-head">
					<button type="button" class="back" onclick={() => (active = null)}>← {t('back')}</button>
					<span class="avatar" aria-hidden="true">{initial(activeContact.name)}</span>
					<div class="who">
						<strong>{activeContact.name}</strong>
						<small>{shortAddress(activeContact.address)}</small>
					</div>
					<span class="lock">{t('f1_title')}</span>
				</header>

				<div class="messages" bind:this={scroller}>
					{#each activeMessages as message (message.mine + message.id)}
						<div class="bubble" class:mine={message.mine} class:failed={message.state === 'failed'}>
							<p>{message.text}</p>
							<small>
								{timeOf(message.ts)}{#if message.mine}{' · ' + stateLabel(message.state)}{/if}
							</small>
						</div>
					{:else}
						<p class="empty center">{t('no_messages')}</p>
					{/each}
				</div>

				<form class="composer" onsubmit={sendMessage}>
					<input bind:value={draft} placeholder={t('ph_message')} autocomplete="off" maxlength={MAX_TEXT} />
					<button type="submit" class="primary" disabled={!draft.trim()}>{t('send')}</button>
				</form>
			{:else}
				<div class="welcome">
					<img src={logo} alt="" width="72" height="72" />
					<h1>MIGA</h1>
					<p class="tagline">Make Internet Great Again</p>
					<p>{t('pick')}</p>
				</div>
			{/if}
		</main>
	{/if}
</div>

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
	.wide {
		width: 100%;
		margin-top: 0.6rem;
	}
	.row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.4rem;
	}
	.add {
		display: grid;
		gap: 0.5rem;
	}
	.add h2 {
		margin-bottom: 0.1rem;
	}

	/* Profile and first-run screen */
	.profile {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		margin-bottom: 0.9rem;
		padding-bottom: 0.9rem;
		border-bottom: 0.5px solid var(--line);
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
	@media (max-width: 760px) {
		.shell {
			grid-template-columns: minmax(0, 1fr);
		}
		.top {
			gap: 0.5rem;
			padding: 0 0.75rem;
		}
		nav {
			gap: 0.5rem;
		}
		/* The dot carries the state; the word comes back on wider screens. */
		.status {
			font-size: 0;
			gap: 0;
			padding: 0.4rem;
		}
		/* Comfortable touch targets, and 16px inputs so phones do not zoom in on focus. */
		.shell :global(button),
		.shell :global(.btn) {
			min-height: 2.75rem;
		}
		.shell :global(input),
		.shell :global(textarea),
		.shell :global(select) {
			font-size: 16px;
		}
		.composer {
			padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
		}
		.shell.chat-open aside,
		.shell:not(.chat-open) main {
			display: none;
		}
		.back {
			display: block;
		}
		.link,
		.lock,
		.close {
			display: none;
		}
	}
</style>
