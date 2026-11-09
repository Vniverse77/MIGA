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
					contacts.push({ address: m.from, name: 'Unknown ' + m.from.slice(0, 6) });
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
				notice = 'The relay rejected a message: ' + code;
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
			notice = `That message is too long (limit: ${MAX_TEXT} characters).`;
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
			notice = 'That is not a valid MIGA address (64 letters and digits).';
			return;
		}
		if (address === identity?.address) {
			notice = 'That is your own address.';
			return;
		}
		if (!contacts.some((c) => c.address === address)) {
			contacts.push({ address, name: newName.trim() || 'Contact ' + address.slice(0, 6) });
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
			notice = 'Your address was copied.';
		} catch {
			notice = 'Could not copy. Select the address and copy it by hand.';
		}
	}

	async function backupKey(): Promise<void> {
		if (!identity) return;
		if (!confirm('Your secret key gives full access to your identity. Copy it to the clipboard?'))
			return;
		try {
			await navigator.clipboard.writeText(bytesToHex(identity.secret));
			notice = 'Secret key copied. Store it somewhere safe and clear your clipboard.';
		} catch {
			notice = 'Could not copy the key.';
		}
	}

	function restoreKey(): void {
		const value = prompt('Paste the secret key to restore (64 characters):')?.trim().toLowerCase();
		if (!value) return;
		if (!/^[0-9a-f]{64}$/.test(value)) {
			notice = 'That is not a valid secret key.';
			return;
		}
		if (!confirm('This replaces the identity stored in this browser. Continue?')) return;
		saveIdentity(identityFromSecret(hexToBytes(value)));
		location.reload();
	}

	const shortAddress = (a: string) => a.slice(0, 8) + '…' + a.slice(-6);
	const timeOf = (ts: number) =>
		new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	const stateLabel: Record<Message['state'], string> = {
		pending: 'waiting to send',
		sent: 'sent',
		failed: 'not sent',
		received: ''
	};
</script>

<svelte:head>
	<title>MIGA</title>
</svelte:head>

<div class="app" class:chat-open={active !== null}>
	<aside>
		<header>
			<a class="brand" href="/">MIGA</a>
			<span class="status {status}">{status}</span>
		</header>

		<div class="me">
			<span class="label">Your address</span>
			<code>{identity?.address ?? '…'}</code>
			<div class="row">
				<button type="button" onclick={copyAddress}>Copy address</button>
				<button type="button" class="quiet" onclick={backupKey}>Back up key</button>
				<button type="button" class="quiet" onclick={restoreKey}>Restore</button>
			</div>
		</div>

		<form class="add" onsubmit={addContact}>
			<span class="label">New conversation</span>
			<input bind:value={newAddress} placeholder="Their MIGA address" autocomplete="off" spellcheck="false" />
			<input bind:value={newName} placeholder="Name (only you see it)" autocomplete="off" maxlength="40" />
			<button type="submit">Start chat</button>
		</form>

		{#if notice}
			<p class="notice" role="status">{notice}</p>
		{/if}

		<ul class="contacts">
			{#each contacts as contact (contact.address)}
				<li>
					<button
						type="button"
						class:selected={contact.address === active}
						onclick={() => (active = contact.address)}
					>
						<strong>{contact.name}</strong>
						<small>{shortAddress(contact.address)}</small>
					</button>
				</li>
			{:else}
				<li class="empty">No conversations yet. Share your address with someone to begin.</li>
			{/each}
		</ul>
	</aside>

	<main>
		{#if activeContact}
			<header>
				<button type="button" class="back quiet" onclick={() => (active = null)}>Back</button>
				<div>
					<strong>{activeContact.name}</strong>
					<small>{shortAddress(activeContact.address)}</small>
				</div>
			</header>

			<div class="messages" bind:this={scroller}>
				{#each activeMessages as message (message.mine + message.id)}
					<div class="bubble" class:mine={message.mine} class:failed={message.state === 'failed'}>
						<p>{message.text}</p>
						<small>
							{timeOf(message.ts)}{#if message.mine}
								· {stateLabel[message.state]}{/if}
						</small>
					</div>
				{:else}
					<p class="empty">No messages yet. Messages are encrypted before they leave this device.</p>
				{/each}
			</div>

			<form class="composer" onsubmit={sendMessage}>
				<input bind:value={draft} placeholder="Write a message" autocomplete="off" maxlength={MAX_TEXT} />
				<button type="submit" disabled={!draft.trim()}>Send</button>
			</form>
		{:else}
			<p class="empty center">Pick a conversation, or start one with someone's MIGA address.</p>
		{/if}
	</main>
</div>

<style>
	.app {
		display: grid;
		grid-template-columns: 21rem 1fr;
		height: 100dvh;
	}
	aside {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		min-height: 0;
		padding: 1rem;
		border-right: 1px solid var(--line);
		background: var(--panel);
		overflow-y: auto;
	}
	aside header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.brand {
		color: var(--text);
		font-size: 1.3rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-decoration: none;
	}
	.status {
		font-size: 0.8rem;
		color: var(--muted);
	}
	.status::before {
		content: '';
		display: inline-block;
		width: 0.55rem;
		height: 0.55rem;
		margin-right: 0.35rem;
		border-radius: 50%;
		background: var(--muted);
	}
	.status.online::before {
		background: var(--accent);
	}
	.status.offline::before {
		background: var(--danger);
	}
	.label {
		display: block;
		margin-bottom: 0.3rem;
		color: var(--muted);
		font-size: 0.8rem;
	}
	code {
		display: block;
		padding: 0.5rem;
		border-radius: 0.4rem;
		background: var(--bg);
		font-size: 0.75rem;
		overflow-wrap: anywhere;
		user-select: all;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.5rem;
	}
	button {
		padding: 0.45rem 0.8rem;
		border: 0;
		border-radius: 0.45rem;
		background: var(--accent);
		color: var(--accent-ink);
		font-weight: 600;
		cursor: pointer;
	}
	button.quiet {
		background: var(--panel-2);
		color: var(--text);
		font-weight: 400;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	input {
		width: 100%;
		padding: 0.55rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: 0.45rem;
		background: var(--bg);
	}
	.add {
		display: grid;
		gap: 0.4rem;
	}
	.notice {
		margin: 0;
		padding: 0.5rem 0.7rem;
		border-radius: 0.45rem;
		background: var(--panel-2);
		font-size: 0.85rem;
	}
	.contacts {
		display: grid;
		gap: 0.3rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.contacts button {
		display: grid;
		width: 100%;
		background: transparent;
		color: var(--text);
		font-weight: 400;
		text-align: left;
	}
	.contacts button:hover,
	.contacts button.selected {
		background: var(--panel-2);
	}
	small {
		color: var(--muted);
		font-size: 0.75rem;
	}
	.empty {
		color: var(--muted);
		font-size: 0.9rem;
	}
	main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	main header {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		padding: 0.8rem 1rem;
		border-bottom: 1px solid var(--line);
	}
	main header div {
		display: grid;
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
		padding: 1rem;
		overflow-y: auto;
	}
	.bubble {
		align-self: flex-start;
		max-width: min(34rem, 85%);
		padding: 0.5rem 0.75rem;
		border-radius: 0.8rem;
		background: var(--panel-2);
	}
	.bubble.mine {
		align-self: flex-end;
		background: #17443f;
	}
	.bubble.failed {
		outline: 1px solid var(--danger);
	}
	.bubble p {
		margin: 0;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}
	.composer {
		display: flex;
		gap: 0.5rem;
		padding: 0.8rem 1rem;
		border-top: 1px solid var(--line);
	}
	.center {
		margin: auto;
		padding: 1rem;
		text-align: center;
	}

	@media (max-width: 720px) {
		.app {
			grid-template-columns: 1fr;
		}
		.app.chat-open aside,
		.app:not(.chat-open) main {
			display: none;
		}
		.back {
			display: block;
		}
	}
</style>
