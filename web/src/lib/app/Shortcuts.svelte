<script lang="ts">
	/** Quick switcher (Ctrl+K) and the shortcut cheat sheet (Ctrl+/). Opened through `layers`. */
	import { tick } from 'svelte';
	import { t } from '../i18n.svelte';
	import { platform } from '../platform';
	import { fold, searchAll, snippet } from '../search';
	import type { Contact, Message } from '../storage';
	import Icon from './Icon.svelte';
	import { layers } from './shortcuts.svelte';

	let {
		contacts,
		chats,
		onchat,
		onhit
	}: {
		contacts: readonly Contact[];
		chats: Record<string, readonly Message[]>;
		onchat: (address: string) => void;
		onhit: (address: string, message: Message) => void;
	} = $props();

	let query = $state('');
	let cursor = $state(0);
	let field = $state<HTMLInputElement | null>(null);

	type Item = { kind: 'chat'; address: string; name: string; sub: string } | { kind: 'hit'; address: string; name: string; message: Message };

	const MAX_CHATS = 8;
	const MAX_HITS = 6;

	const items = $derived.by<Item[]>(() => {
		const q = fold(query.trim());
		const found: Item[] = contacts
			.filter((c) => !q || fold(c.name).includes(q) || c.address.startsWith(q))
			.slice(0, MAX_CHATS)
			.map((c) => ({ kind: 'chat', address: c.address, name: c.name, sub: c.address.slice(0, 8) + '…' }));
		if (q.length >= 2) {
			const name = (a: string) => contacts.find((c) => c.address === a)?.name ?? a.slice(0, 8);
			const hits = searchAll(chats, query).groups.flatMap((g) => g.hits.map((m) => ({ kind: 'hit' as const, address: g.chat, name: name(g.chat), message: m })));
			found.push(...hits.slice(0, MAX_HITS));
		}
		return found;
	});

	$effect(() => {
		if (layers.switcher) {
			query = '';
			cursor = 0;
			void tick().then(() => field?.focus());
		}
	});
	$effect(() => {
		void query;
		cursor = 0;
	});

	function pick(item: Item | undefined): void {
		if (!item) return;
		layers.switcher = false;
		if (item.kind === 'chat') onchat(item.address);
		else onhit(item.address, item.message);
	}

	function onKey(e: KeyboardEvent): void {
		if (e.isComposing || e.keyCode === 229) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const n = items.length;
			if (n) cursor = (cursor + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
			void tick().then(() => document.querySelector('.kb-item.on')?.scrollIntoView({ block: 'nearest' }));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			pick(items[cursor]);
		}
	}

	const mod = 'Ctrl';
	const rows = $derived([
		{ keys: [mod + '+K'], label: t('kb_switcher') },
		{ keys: [platform.shortcuts?.newChat ?? 'Ctrl+N'], label: t('kb_new_chat') },
		{ keys: [mod + '+,'], label: t('kb_settings') },
		{ keys: ['Alt+Up', 'Alt+Down'], label: t('kb_step') },
		{ keys: ['Up'], label: t('kb_edit_last') },
		...(platform.shortcuts?.find ? [{ keys: [mod + '+F'], label: t('kb_find') }] : []),
		{ keys: [mod + '+/'], label: t('kb_help') },
		{ keys: ['Esc'], label: t('kb_esc') }
	]);
</script>

{#if layers.switcher}
	<div class="kb-scrim" role="presentation" onmousedown={(e) => e.target === e.currentTarget && (layers.switcher = false)}>
		<div class="kb-box" role="dialog" aria-modal="true" data-kb aria-label={t('kb_switcher')}>
			<div class="kb-head">
				<Icon name="search" size={18} />
				<input bind:this={field} bind:value={query} onkeydown={onKey} type="text" autocomplete="off" spellcheck="false" placeholder={t('kb_switch_placeholder')} aria-label={t('kb_switch_placeholder')} />
				<kbd>Esc</kbd>
			</div>
			<ul class="kb-list" role="listbox">
				{#each items as item, i (item.kind + item.address + (item.kind === 'hit' ? item.message.id + item.message.mine : ''))}
					{#if i === 0 || items[i - 1].kind !== item.kind}
						<li class="kb-group" role="presentation">{item.kind === 'chat' ? t('kb_chats') : t('kb_messages')}</li>
					{/if}
					<li role="option" aria-selected={i === cursor}>
						<button type="button" class="kb-item" class:on={i === cursor} tabindex="-1" onmousemove={() => (cursor = i)} onclick={() => pick(item)}>
							<span class="kb-av" aria-hidden="true">{(item.name.trim()[0] ?? '?').toUpperCase()}</span>
							{#if item.kind === 'chat'}
								<span class="kb-main"><strong>{item.name}</strong><small>{item.sub}</small></span>
							{:else}
								<span class="kb-main">
									<strong>{item.name}</strong>
									<small>{#each snippet(item.message.text, query) as seg, si (si)}{#if seg.hit}<mark>{seg.t}</mark>{:else}{seg.t}{/if}{/each}</small>
								</span>
							{/if}
						</button>
					</li>
				{:else}
					<li class="kb-none">{t('kb_none')}</li>
				{/each}
			</ul>
			<div class="kb-foot">{t('kb_switch_hint')}</div>
		</div>
	</div>
{/if}

{#if layers.help}
	<div class="kb-scrim" role="presentation" onmousedown={(e) => e.target === e.currentTarget && (layers.help = false)}>
		<div class="kb-box help" role="dialog" aria-modal="true" data-kb aria-label={t('kb_title')}>
			<div class="kb-head">
				<h2>{t('kb_title')}</h2>
				<button type="button" class="kb-x" aria-label={t('close')} title={t('close')} onclick={() => (layers.help = false)}><Icon name="close" size={18} /></button>
			</div>
			<dl class="kb-rows">
				{#each rows as row (row.label)}
					<div>
						<dt>{row.label}</dt>
						<dd>{#each row.keys as k, i (k)}{#if i}<span class="or">/</span>{/if}<kbd>{k}</kbd>{/each}</dd>
					</div>
				{/each}
			</dl>
		</div>
	</div>
{/if}

<style>
	.kb-scrim {
		position: fixed;
		inset: 0;
		z-index: 200;
		display: grid;
		align-items: start;
		justify-items: center;
		padding: 14vh 1rem 1rem;
		background: rgba(0, 0, 0, 0.5);
	}
	.kb-box {
		width: min(34rem, 100%);
		max-height: 70vh;
		display: flex;
		flex-direction: column;
		border: 0.5px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--panel);
		color: var(--text);
		overflow: hidden;
	}
	.kb-head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.7rem 0.9rem;
		border-bottom: 0.5px solid var(--line);
		color: var(--muted);
	}
	.kb-head input {
		flex: 1;
		min-width: 0;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--heading);
		font: inherit;
		font-size: 0.95rem;
	}
	.kb-head h2 {
		flex: 1;
		margin: 0;
		font-size: 0.95rem;
		font-weight: 500;
		color: var(--heading);
	}
	.kb-x {
		display: grid;
		place-items: center;
		width: 1.9rem;
		height: 1.9rem;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}
	.kb-x:hover {
		color: var(--heading);
		background: rgba(26, 107, 191, 0.12);
	}
	.kb-list {
		list-style: none;
		margin: 0;
		padding: 0.3rem;
		overflow-y: auto;
	}
	.kb-group {
		padding: 0.5rem 0.6rem 0.2rem;
		font-size: 0.7rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.kb-item {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		width: 100%;
		min-height: 0;
		padding: 0.45rem 0.6rem;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.kb-item.on {
		background: rgba(26, 107, 191, 0.18);
		color: var(--heading);
	}
	.kb-av {
		flex: none;
		display: grid;
		place-items: center;
		width: 1.8rem;
		height: 1.8rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		font-size: 0.8rem;
		color: var(--link);
	}
	.kb-main {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.kb-main strong {
		font-weight: 500;
		font-size: 0.9rem;
	}
	.kb-main small {
		color: var(--muted);
		font-size: 0.78rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.kb-main mark {
		background: rgba(26, 107, 191, 0.3);
		color: var(--heading);
		border-radius: 3px;
	}
	.kb-none {
		padding: 1rem;
		text-align: center;
		color: var(--muted);
		font-size: 0.85rem;
	}
	.kb-foot {
		padding: 0.5rem 0.9rem;
		border-top: 0.5px solid var(--line);
		color: var(--muted);
		font-size: 0.72rem;
	}
	.kb-rows {
		margin: 0;
		padding: 0.4rem 0.9rem 0.8rem;
	}
	.kb-rows > div {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		padding: 0.5rem 0;
		border-bottom: 0.5px solid var(--line);
	}
	.kb-rows > div:last-child {
		border-bottom: 0;
	}
	.kb-rows dt {
		font-size: 0.85rem;
	}
	.kb-rows dd {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin: 0;
		flex: none;
	}
	.or {
		color: var(--muted);
		font-size: 0.75rem;
	}
	kbd {
		display: inline-block;
		min-width: 1.5rem;
		padding: 0.1rem 0.4rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--heading);
		font: inherit;
		font-size: 0.72rem;
		text-align: center;
	}
</style>
