<script lang="ts">
	import { getLanguage, languages, setLanguage, t, type Lang } from './i18n.svelte';
	import { platform } from './platform';

	// The desktop window uses its own dropdown: the browser's raw list looks like a web page.
	const custom = platform.target === 'desktop';

	let open = $state(false);
	let index = $state(0);
	let root: HTMLDivElement | undefined = $state();
	let button: HTMLButtonElement | undefined = $state();

	const currentName = $derived(languages.find((l) => l.code === getLanguage())?.name ?? '');

	function show() {
		index = Math.max(
			0,
			languages.findIndex((l) => l.code === getLanguage())
		);
		open = true;
	}

	function choose(code: Lang) {
		setLanguage(code);
		open = false;
		button?.focus();
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && open) {
			event.preventDefault();
			event.stopPropagation();
			open = false;
			button?.focus();
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (!open) return show();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			index = (index + step + languages.length) % languages.length;
		} else if ((event.key === 'Enter' || event.key === ' ') && open) {
			event.preventDefault();
			choose(languages[index].code);
		}
	}

	function onwindowpointerdown(event: PointerEvent) {
		if (open && root && !root.contains(event.target as Node)) open = false;
	}
</script>

<svelte:window onpointerdown={onwindowpointerdown} />

{#if custom}
	<div class="wrap" bind:this={root}>
		<button
			bind:this={button}
			type="button"
			class="trigger"
			aria-label={t('language')}
			aria-haspopup="listbox"
			aria-expanded={open}
			onclick={() => (open ? (open = false) : show())}
			{onkeydown}
		>
			<span>{currentName}</span>
			<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
				<path d="M2 4.5 6 8.5 10 4.5" fill="none" stroke="currentColor" stroke-width="1.5" />
			</svg>
		</button>
		{#if open}
			<ul class="pop" role="listbox" aria-label={t('language')}>
				{#each languages as language, i (language.code)}
					<li
						role="option"
						aria-selected={language.code === getLanguage()}
						class:sel={language.code === getLanguage()}
						class:hot={i === index}
						onpointerenter={() => (index = i)}
						onclick={() => choose(language.code)}
						onkeydown={() => {}}
					>
						{language.name}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{:else}
	<select
		aria-label={t('language')}
		value={getLanguage()}
		onchange={(event) => setLanguage(event.currentTarget.value as Lang)}
	>
		{#each languages as language (language.code)}
			<option value={language.code}>{language.name}</option>
		{/each}
	</select>
{/if}

<style>
	select {
		padding: 0.35rem 0.5rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
		max-width: 100%;
	}
	@media (max-width: 760px) {
		select {
			max-width: 7rem;
			padding: 0.35rem 0.3rem;
		}
	}
	.wrap {
		position: relative;
		display: inline-block;
	}
	.trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.6rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
		transition:
			background-color 0.11s ease,
			border-color 0.11s ease;
	}
	.trigger:hover,
	select:hover {
		border-color: var(--accent-2);
		background: var(--panel);
	}
	.pop {
		position: absolute;
		z-index: 40;
		top: calc(100% + 4px);
		right: 0;
		min-width: 100%;
		margin: 0;
		padding: 0.25rem;
		list-style: none;
		background: var(--panel-2);
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
	}
	.pop li {
		padding: 0.35rem 0.6rem;
		border-radius: var(--radius);
		font-size: 0.85rem;
		white-space: nowrap;
		cursor: pointer;
		transition: background-color 0.11s ease;
	}
	.pop li.hot {
		background: var(--panel);
	}
	.pop li.sel {
		color: var(--accent-2);
	}
</style>
