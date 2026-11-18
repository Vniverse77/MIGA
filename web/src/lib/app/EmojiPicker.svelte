<script lang="ts">
	// Loaded on demand (dynamic import), so the emoji data is not part of the main bundle.
	// Data: unicode-emoji-json (MIT), compacted by scripts/gen-emoji.mjs. No network access.
	import { onMount, untrack } from 'svelte';
	import { t } from '../i18n.svelte';
	import { loadRecentEmoji, pushRecentEmoji } from '../emoji';
	import data from './emoji-data.json';

	let { onpick }: { onpick: (emoji: string) => void } = $props();

	const groups = data as { id: string; e: [string, string][] }[];
	// One glyph stands for each category in the tab strip.
	const GLYPH: Record<string, string> = {
		smileys_emotion: '😀',
		people_body: '🧑',
		animals_nature: '🐻',
		food_drink: '🍔',
		travel_places: '✈️',
		activities: '⚽',
		objects: '💡',
		symbols: '🔣',
		flags: '🏁'
	};

	const catName = (id: string) => t(`cat_${id}` as 'cat_flags');
	let recent = $state(loadRecentEmoji());
	let query = $state('');
	let tab = $state(untrack(() => (recent.length ? 'recent' : 'smileys_emotion')));
	let search = $state<HTMLInputElement | null>(null);
	let grid = $state<HTMLElement | null>(null);

	const needle = $derived(query.trim().toLowerCase());
	const shown = $derived.by((): [string, string][] => {
		if (needle) {
			const words = needle.split(/\s+/);
			const out: [string, string][] = [];
			for (const g of groups)
				for (const item of g.e) {
					if (words.every((w) => item[1].includes(w))) out.push(item);
					if (out.length >= 160) return out;
				}
			return out;
		}
		if (tab === 'recent') return recent.map((e) => [e, ''] as [string, string]);
		return groups.find((g) => g.id === tab)?.e ?? [];
	});

	onMount(() => search?.focus());

	function pick(emoji: string): void {
		recent = pushRecentEmoji(emoji);
		onpick(emoji);
	}

	/** Arrow keys move through the grid; the row length is read from the layout. */
	function onGridKey(event: KeyboardEvent): void {
		const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
		if (!keys.includes(event.key) || !grid) return;
		const cells = [...grid.querySelectorAll<HTMLButtonElement>('button')];
		const at = cells.indexOf(document.activeElement as HTMLButtonElement);
		if (at < 0) return;
		const perRow = cells.filter((c) => c.offsetTop === cells[0].offsetTop).length || 1;
		const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -perRow, ArrowDown: perRow }[event.key]!;
		const next = cells[Math.max(0, Math.min(cells.length - 1, at + step))];
		event.preventDefault();
		next?.focus();
	}

	function onSearchKey(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			grid?.querySelector<HTMLButtonElement>('button')?.focus();
		}
	}
</script>

<div class="emoji-panel" role="dialog" aria-label={t('emoji_picker')}>
	<input
		bind:this={search}
		bind:value={query}
		class="emoji-search"
		type="search"
		placeholder={t('emoji_search')}
		aria-label={t('emoji_search')}
		autocomplete="off"
		onkeydown={onSearchKey}
	/>
	{#if !needle}
		<div class="emoji-tabs" role="tablist">
			<button type="button" role="tab" class:on={tab === 'recent'} aria-selected={tab === 'recent'} aria-label={t('emoji_recent')} title={t('emoji_recent')} onclick={() => (tab = 'recent')}>
				<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="9" />
					<path d="M12 7v5l3 2" />
				</svg>
			</button>
			{#each groups as g (g.id)}
				<button type="button" role="tab" class:on={tab === g.id} aria-selected={tab === g.id} aria-label={catName(g.id)} title={catName(g.id)} onclick={() => (tab = g.id)}>
					<span aria-hidden="true">{GLYPH[g.id] ?? '·'}</span>
				</button>
			{/each}
		</div>
	{/if}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div class="emoji-grid" bind:this={grid} role="group" aria-label={needle ? t('emoji_search') : tab === 'recent' ? t('emoji_recent') : catName(tab)} onkeydown={onGridKey}>
		{#each shown as [emoji, name], i (emoji + i)}
			<button type="button" tabindex={i === 0 ? 0 : -1} title={name} aria-label={name || emoji} onclick={() => pick(emoji)}>{emoji}</button>
		{:else}
			<p class="emoji-empty">{needle ? t('emoji_none') : tab === 'recent' ? t('emoji_none') : ''}</p>
		{/each}
	</div>
</div>

<style>
	.emoji-panel {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		height: min(18rem, 42dvh);
		padding: 0.6rem 1.25rem;
		border-top: 0.5px solid var(--line);
		background: var(--panel);
	}
	.emoji-search {
		flex: none;
		width: 100%;
		appearance: none;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--text);
	}
	.emoji-tabs {
		flex: none;
		display: flex;
		gap: 0.15rem;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.emoji-tabs button {
		flex: none;
		display: grid;
		place-items: center;
		min-width: 2.2rem;
		min-height: 2.2rem;
		padding: 0.1rem 0.4rem;
		border: 0;
		border-bottom: 2px solid transparent;
		border-radius: 6px 6px 0 0;
		background: none;
		color: var(--muted);
		font-size: 1.15rem;
		cursor: pointer;
	}
	.emoji-tabs button:hover:not(:disabled) {
		background: none;
		color: var(--heading);
	}
	.emoji-tabs button.on {
		border-bottom-color: var(--accent-2);
		color: var(--heading);
	}
	.emoji-grid {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(2.4rem, 1fr));
		grid-auto-rows: 2.4rem;
		gap: 0.1rem;
		overflow-y: auto;
		align-content: start;
	}
	.emoji-grid button {
		display: grid;
		place-items: center;
		min-height: 0;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: none;
		font-size: 1.5rem;
		line-height: 1;
		cursor: pointer;
	}
	.emoji-grid button:hover,
	.emoji-grid button:focus-visible {
		background: var(--line);
	}
	.emoji-empty {
		grid-column: 1 / -1;
		margin: 1rem 0;
		color: var(--muted);
		text-align: center;
	}
</style>
