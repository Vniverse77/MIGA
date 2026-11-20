<script lang="ts">
	// New group: a name, up to four of my contacts, a generated pixel avatar. A bottom sheet on touch, a centred modal with a mouse (Sheet).
	import Sheet from './Sheet.svelte';
	import Icon from './Icon.svelte';
	import { groupAvatarUrl } from '../avatar';
	import { canCreate } from '../group-ui';
	import { MAX_GROUP_NAME, MAX_MEMBERS } from '../groups';
	import { randomId } from '../crypto';
	import { t } from '../i18n.svelte';

	type Pick = { address: string; name: string };
	let {
		contacts,
		avSrc,
		oncreate,
		onclose
	}: { contacts: Pick[]; avSrc: (address: string) => string; oncreate: (name: string, picked: string[], gid: string) => Promise<void> | void; onclose: () => void } = $props();

	const max = MAX_MEMBERS - 1;
	const gid = randomId();
	let name = $state('');
	let picked = $state<string[]>([]);
	let busy = $state(false);
	const full = $derived(picked.length >= max);
	const ok = $derived(canCreate(name, picked.length));

	function toggle(address: string): void {
		picked = picked.includes(address) ? picked.filter((a) => a !== address) : full ? picked : [...picked, address];
	}

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!ok || busy) return;
		busy = true;
		await oncreate(name, picked, gid);
	}
</script>

<Sheet title={t('g_new')} {onclose} {busy}>
	<form class="gc" onsubmit={submit}>
		<div class="head">
			<img class="gav" src={groupAvatarUrl(gid)} alt="" width="56" height="56" />
			<input data-autofocus bind:value={name} maxlength={MAX_GROUP_NAME} placeholder={t('g_name_ph')} aria-label={t('g_name')} autocomplete="off" enterkeyhint="done" />
		</div>
		<div class="count" role="status" data-picked={picked.length}>
			<span>{t('g_pick_members')}</span>
			<strong class:full>{picked.length}/{max}</strong>
		</div>
		<ul class="list" role="group" aria-label={t('g_pick_members')}>
			{#each contacts as c (c.address)}
				{@const on = picked.includes(c.address)}
				<li>
					<button type="button" class="row" class:on role="checkbox" aria-checked={on} disabled={!on && full} data-pick={c.address} onclick={() => toggle(c.address)}>
						<img src={avSrc(c.address)} alt="" class="av" />
						<span class="nm">{c.name}</span>
						<span class="box" aria-hidden="true">{#if on}<Icon name="check" size={16} />{/if}</span>
					</button>
				</li>
			{:else}
				<li class="none">{t('g_no_contacts')}</li>
			{/each}
		</ul>
		{#if full}<p class="hint" role="status">{t('g_limit_members', { n: MAX_MEMBERS })}</p>{/if}
		<div class="actions">
			<button type="submit" class="go" disabled={!ok || busy} title={t('g_create')} aria-label={t('g_create')} data-create><Icon name="check" size={22} /></button>
		</div>
	</form>
</Sheet>

<style>
	.gc {
		display: grid;
		gap: 0.7rem;
		min-width: 0;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.gav {
		flex: none;
		width: 56px;
		height: 56px;
		border-radius: 12px;
		image-rendering: pixelated;
		border: 0.5px solid var(--line-strong);
	}
	input {
		flex: 1;
		min-width: 0;
	}
	.count {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		color: var(--muted);
		font-size: var(--fs-small);
	}
	.count strong {
		color: var(--heading);
		font-variant-numeric: tabular-nums;
	}
	.count strong.full {
		color: var(--accent-2);
	}
	.list {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
		max-height: min(40dvh, 20rem);
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		width: 100%;
		min-height: 48px;
		padding: 0.3rem 0.5rem;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}
	.row:hover:not(:disabled),
	.row.on {
		background: var(--panel-2);
	}
	.row:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.av {
		flex: none;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		object-fit: cover;
		image-rendering: pixelated;
	}
	.nm {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.box {
		display: grid;
		place-items: center;
		flex: none;
		width: 22px;
		height: 22px;
		border: 1.5px solid var(--line-strong);
		border-radius: 6px;
		color: var(--accent-ink);
	}
	.row.on .box {
		border-color: var(--accent);
		background: var(--accent);
	}
	.none,
	.hint {
		margin: 0;
		color: var(--muted);
		font-size: var(--fs-small);
		list-style: none;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
	}
	.go {
		display: grid;
		place-items: center;
		width: 48px;
		height: 48px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: var(--accent);
		color: var(--accent-ink);
		cursor: pointer;
	}
	.go:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
