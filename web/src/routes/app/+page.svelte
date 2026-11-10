<script lang="ts">
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
	import logo from '../../lib/assets/favicon.svg';
	import { t } from '../../lib/i18n.svelte';
	import LangSelect from '../../lib/LangSelect.svelte';
	import { RelayClient, type Status } from '../../lib/relay';
	import {
		loadChats,
		loadContacts,
		loadIdentity,
		saveChats,
		saveContacts,
		saveIdentity,
		type Chats,
		type Contact,
		type Message
	} from '../../lib/storage';

	const MAX_TEXT = 4000;

	let identity = $state.raw<Identity | null>(null);
	let status = $state<Status>('offline');
	let contacts = $state<Contact[]>([]);
	let chats = $state<Chats>({});
	let active = $state<string | null>(null);
	let draft = $state('');
	let newAddress = $state('');
	let newName = $state('');
	let notice = $state('');
	let scroller = $state<HTMLElement | null>(null);
	let relay: RelayClient | null = null;

	const activeContact = $derived(contacts.find((c) => c.address === active) ?? null);
	const activeMessages = $derived(active ? (chats[active] ?? []) : []);

	onMount(() => {
		const me = loadIdentity();
		identity = me;
		contacts = loadContacts();
		chats = loadChats();

		const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
		relay = new RelayClient(scheme + location.host + '/ws', me, {
			onStatus: (s) => (status = s),
			onReady: () => resendPending(me),
			onMessage: (m) => {
				const plain = decrypt(me, m.from, m.body);
				// Anything we cannot open is acknowledged too, so it does not clog the queue.
				if (!plain) return true;
				if (!contacts.some((c) => c.address === m.from)) {
					contacts.push({ address: m.from, name: t('name_unknown') + ' ' + m.from.slice(0, 6) });
				}
				if (!chats[m.from]) chats[m.from] = [];
				const list = chats[m.from];
				if (!list.some((x) => !x.mine && x.id === m.id)) {
					list.push({
						id: m.id,
						mine: false,
						text: plain.text.slice(0, MAX_TEXT),
						ts: m.ts,
						state: 'received'
					});
				}
				persist();
				return true;
			},
			onSent: (id) => setMessageState(id, 'sent'),
			onError: (code, id) => {
				if (id) setMessageState(id, 'failed');
				notice = t('n_relay_rejected', { code });
			}
		});
		relay.connect();
		return () => relay?.close();
	});

	$effect(() => {
		void activeMessages.length;
		scroller?.scrollTo(0, scroller.scrollHeight);
	});

	function persist(): void {
		saveContacts($state.snapshot(contacts));
		saveChats($state.snapshot(chats));
	}

	function setMessageState(id: string, state: Message['state']): void {
		for (const list of Object.values(chats)) {
			const found = list.find((m) => m.mine && m.id === id);
			if (found) {
				found.state = state;
				persist();
				return;
			}
		}
	}

	function resendPending(me: Identity): void {
		for (const [address, list] of Object.entries(chats)) {
			for (const m of list) {
				if (m.mine && m.state === 'pending') relay?.send(address, m.id, encrypt(me, address, m.text));
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
		relay?.send(active, id, encrypt(identity, active, text));
	}

	function addContact(event: SubmitEvent): void {
		event.preventDefault();
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
			contacts.push({ address, name: newName.trim() || t('name_contact') + ' ' + address.slice(0, 6) });
			persist();
		}
		newAddress = '';
		newName = '';
		notice = '';
		active = address;
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
		if (!confirm(t('q_restore_confirm'))) return;
		saveIdentity(identityFromSecret(hexToBytes(value)));
		location.reload();
	}

	const initial = (name: string) => [...name.trim()][0] ?? '?';
	const shortAddress = (a: string) => a.slice(0, 8) + '…' + a.slice(-6);
	const timeOf = (ts: number) =>
		new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	const stateLabel = (state: Message['state']) =>
		state === 'received' ? '' : t(`state_${state}`);
</script>

<svelte:head>
	<title>MIGA</title>
</svelte:head>

<div class="shell" class:chat-open={active !== null}>
	<header class="top">
		<a class="brand" href="/">
			<img src={logo} alt="" width="30" height="30" />
			<span>MIGA</span>
		</a>
		<nav aria-label="Main">
			<a class="link" href="https://vniverse77.com/">Vniverse77</a>
			<a class="link" href="https://forum.vniverse77.com/">Forum</a>
			<span class="status {status}">{t(`status_${status}`)}</span>
			<LangSelect />
		</nav>
	</header>

	<aside>
		<section class="card">
			<h2>{t('your_address')}</h2>
			<code>{identity?.address ?? '…'}</code>
			<div class="row">
				<button type="button" class="primary" onclick={copyAddress}>{t('copy_address')}</button>
				<button type="button" onclick={backupKey}>{t('backup_key')}</button>
				<button type="button" onclick={restoreKey}>{t('restore')}</button>
			</div>
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
						class:selected={contact.address === active}
						onclick={() => (active = contact.address)}
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
		{#if activeContact}
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
		margin-top: 0.6rem;
	}
	.row .primary {
		grid-column: 1 / -1;
	}
	.add {
		display: grid;
		gap: 0.5rem;
	}
	.add h2 {
		margin-bottom: 0.1rem;
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

	@media (max-width: 760px) {
		.shell {
			grid-template-columns: 1fr;
		}
		.shell.chat-open aside,
		.shell:not(.chat-open) main {
			display: none;
		}
		.back {
			display: block;
		}
		.link,
		.lock {
			display: none;
		}
	}
</style>
