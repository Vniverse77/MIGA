<script lang="ts">
	// Loaded on demand (dynamic import). The user's GIFs come from this device's IndexedDB; the
	// default set is fetched from /gifs/ only once this panel shows it. No network search.
	import { onDestroy, onMount } from 'svelte';
	import { t } from '../i18n.svelte';
	import { DEFAULT_GIFS, addGif, defaultFile, defaultUrl, listGifs, loadHidden, removeGif, saveHidden, type MyGif } from '../gifs';
	import Icon from './Icon.svelte';

	let { onsend, onnotice }: { onsend: (file: File) => void; onnotice: (text: string) => void } = $props();

	type Tile = MyGif & { url: string };
	let tab = $state<'mine' | 'default'>('mine');
	let mine = $state<Tile[]>([]);
	let hidden = $state(loadHidden());
	let ready = $state(false);
	let over = $state(false);
	let input = $state<HTMLInputElement | null>(null);
	let panel = $state<HTMLElement | null>(null);

	const shown = $derived(DEFAULT_GIFS.filter((n) => !hidden.includes(n)));

	function release(): void {
		for (const g of mine) URL.revokeObjectURL(g.url);
	}

	async function refresh(): Promise<void> {
		const list = await listGifs();
		release();
		mine = list.map((g) => ({ ...g, url: URL.createObjectURL(g.data) }));
		ready = true;
	}

	onMount(() => {
		void refresh().then(() => {
			if (!mine.length) tab = 'default';
		});
		panel?.focus();
	});
	onDestroy(release);

	async function add(files: Iterable<File>): Promise<void> {
		let added = false;
		for (const file of files) {
			const res = await addGif(file);
			if (res === 'ok') added = true;
			else onnotice(res === 'too_big' ? t('gif_big') : t('gif_bad'));
		}
		if (added) {
			await refresh();
			tab = 'mine';
		}
	}

	async function sendMine(g: Tile): Promise<void> {
		onsend(new File([g.data], `gif.${g.mime === 'image/gif' ? 'gif' : 'webp'}`, { type: g.mime }));
	}

	async function sendDefault(name: string): Promise<void> {
		try {
			onsend(await defaultFile(name));
		} catch {
			onnotice(t('gif_load'));
		}
	}

	async function drop(mineGif: Tile): Promise<void> {
		await removeGif(mineGif.id);
		await refresh();
	}

	function hide(name: string): void {
		hidden = [...hidden, name];
		saveHidden(hidden);
	}

	function restore(): void {
		hidden = [];
		saveHidden(hidden);
	}

	function onPaste(e: ClipboardEvent): void {
		const files = [...(e.clipboardData?.files ?? [])];
		if (!files.length) return;
		e.preventDefault();
		void add(files);
	}

	function onDrop(e: DragEvent): void {
		if (!e.dataTransfer?.files.length) return;
		e.preventDefault();
		e.stopPropagation(); // the chat's own drop handler would send the file instead
		over = false;
		void add([...e.dataTransfer.files]);
	}

	function onDragOver(e: DragEvent): void {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		e.stopPropagation();
		over = true;
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="gif-panel"
	class:over
	bind:this={panel}
	role="dialog"
	tabindex="-1"
	aria-label={t('gif_panel')}
	onpaste={onPaste}
	ondragover={onDragOver}
	ondragleave={() => (over = false)}
	ondrop={onDrop}
>
	<div class="gif-head">
		<div class="gif-tabs" role="tablist">
			<button type="button" role="tab" class:on={tab === 'mine'} aria-selected={tab === 'mine'} onclick={() => (tab = 'mine')}>{t('gif_mine')}</button>
			<button type="button" role="tab" class:on={tab === 'default'} aria-selected={tab === 'default'} onclick={() => (tab = 'default')}>{t('gif_default')}</button>
		</div>
		<button type="button" class="gif-add" aria-label={t('gif_add')} title={t('gif_add')} onclick={() => input?.click()}>
			<Icon name="plus" size={16} />
			<span>{t('gif_add')}</span>
		</button>
		<input bind:this={input} class="gif-file" type="file" multiple accept="image/gif,image/webp" tabindex="-1" aria-hidden="true" onchange={(e) => { void add([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ''; }} />
	</div>
	<div class="gif-grid" role="group" aria-label={tab === 'mine' ? t('gif_mine') : t('gif_default')}>
		{#if tab === 'mine'}
			{#each mine as g (g.id)}
				<div class="tile">
					<button type="button" class="pick" aria-label={t('gif_send')} title={t('gif_send')} onclick={() => sendMine(g)}>
						<img src={g.url} alt="" draggable="false" />
					</button>
					<button type="button" class="x" aria-label={t('gif_remove')} title={t('gif_remove')} onclick={() => drop(g)}><Icon name="close" size={12} /></button>
				</div>
			{:else}
				{#if ready}<p class="gif-empty">{t('gif_empty')}</p>{/if}
			{/each}
		{:else}
			{#each shown as name (name)}
				<div class="tile">
					<button type="button" class="pick" aria-label={t('gif_send')} title={t('gif_send')} onclick={() => sendDefault(name)}>
						<img src={defaultUrl(name)} alt="" loading="lazy" decoding="async" draggable="false" />
					</button>
					<button type="button" class="x" aria-label={t('gif_hide')} title={t('gif_hide')} onclick={() => hide(name)}><Icon name="close" size={12} /></button>
				</div>
			{/each}
			{#if hidden.length}
				<button type="button" class="gif-restore" onclick={restore}>{t('gif_restore')}</button>
			{/if}
		{/if}
	</div>
</div>

<style>
	.gif-panel {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		height: min(18rem, 40dvh);
		padding: 0.6rem 1.25rem;
		border-top: 0.5px solid var(--line);
		background: var(--panel);
		outline: none;
	}
	.gif-panel.over {
		outline: 2px dashed var(--accent-2);
		outline-offset: -6px;
	}
	.gif-head {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.gif-tabs {
		display: flex;
		gap: 0.15rem;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.gif-tabs button {
		flex: none;
		min-height: 2.2rem;
		padding: 0.1rem 0.7rem;
		border: 0;
		border-bottom: 2px solid transparent;
		border-radius: 6px 6px 0 0;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 0.9em;
		cursor: pointer;
	}
	.gif-tabs button:hover:not(:disabled) {
		background: none;
		color: var(--heading);
	}
	.gif-tabs button.on {
		border-bottom-color: var(--accent-2);
		color: var(--heading);
	}
	.gif-add {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 2.2rem;
		padding: 0 0.7rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: none;
		color: var(--text);
		font: inherit;
		font-size: 0.85em;
		cursor: pointer;
	}
	.gif-add:hover:not(:disabled) {
		background: var(--line);
	}
	.gif-file {
		display: none;
	}
	.gif-grid {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
		grid-auto-rows: 6.5rem;
		gap: 0.4rem;
		overflow-y: auto;
		align-content: start;
	}
	.tile {
		position: relative;
		min-height: 0;
		border-radius: var(--radius);
		overflow: hidden;
		background: var(--bg);
		border: 0.5px solid var(--line);
	}
	.tile .pick {
		display: block;
		width: 100%;
		height: 100%;
		min-height: 0;
		padding: 0;
		border: 0;
		border-radius: 0;
		background: none;
		cursor: pointer;
	}
	.tile img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.tile .pick:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: -2px;
	}
	.gif-panel .tile .x {
		position: absolute;
		top: 0.2rem;
		right: 0.2rem;
		display: grid;
		place-items: center;
		width: 1.6rem;
		height: 1.6rem;
		min-height: 0;
		padding: 0;
		border: 0.5px solid var(--line-strong);
		border-radius: 50%;
		background: color-mix(in srgb, var(--bg) 80%, transparent);
		color: var(--heading);
		cursor: pointer;
	}
	.tile .x:hover:not(:disabled) {
		background: var(--bg);
		color: var(--danger);
	}
	.gif-empty {
		grid-column: 1 / -1;
		margin: 1rem 0;
		color: var(--muted);
		text-align: center;
		font-size: 0.9em;
	}
	.gif-restore {
		grid-column: 1 / -1;
		justify-self: center;
		min-height: 2.2rem;
		padding: 0 0.8rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 0.85em;
		cursor: pointer;
	}
</style>
