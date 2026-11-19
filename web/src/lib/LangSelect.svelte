<script lang="ts">
	import { tick } from 'svelte';
	import { getLanguage, languages, setLanguage, t, type Lang } from './i18n.svelte';
	import { layers } from './app/shortcuts.svelte';
	
	// One styled dropdown on every platform: the native list differs per browser and phone.
	const custom = true;

	// Touch phones get a bottom sheet with radio rows (Back closes it); a mouse gets the dropdown.
	const sheetMode = () => typeof matchMedia === 'function' && matchMedia('(max-width: 760px) and (hover: none)').matches;
	let sheet = $state(false);
	$effect(() => {
		layers.lang = sheet;
		if (sheet) tick().then(() => root?.querySelector<HTMLElement>('.sheet [aria-checked="true"]')?.focus());
		return () => {
			layers.lang = false;
		};
	});
	$effect(() => {
		if (!layers.lang) sheet = false;
	});
	let open = $state(false);
	let index = $state(0);
	let root: HTMLDivElement | undefined = $state();
	let button: HTMLButtonElement | undefined = $state();

	const currentName = $derived(languages.find((l) => l.code === getLanguage())?.name ?? '');

	function show() {
		if (sheetMode()) {
			sheet = true;
			return;
		}
		index = Math.max(
			0,
			languages.findIndex((l) => l.code === getLanguage())
		);
		open = true;
	}

	function choose(code: Lang) {
		setLanguage(code);
		open = false;
		sheet = false;
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
		{#if sheet}
			<div class="scrim" role="presentation" onclick={() => (sheet = false)}></div>
			<div
				class="sheet"
				role="radiogroup"
				aria-label={t('language')}
				tabindex="-1"
				onkeydown={(e) => {
					if (e.key === 'Escape') {
						e.stopPropagation();
						sheet = false;
						button?.focus();
					}
				}}
			>
				<span class="grip"></span>
				<h3>{t('language')}</h3>
				{#each languages as language (language.code)}
					<button type="button" role="radio" aria-checked={language.code === getLanguage()} onclick={() => choose(language.code)}>
						<span class="dot"></span>{language.name}
					</button>
				{/each}
			</div>
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
	.wrap > .trigger.trigger.trigger {
		display: inline-flex;
		height: 2rem;
		min-height: 2rem;
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
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 95;
		background: rgba(0, 0, 0, 0.5);
	}
	.sheet {
		position: fixed;
		right: 0;
		bottom: 0;
		left: 0;
		z-index: 96;
		display: grid;
		max-height: 80dvh;
		overflow-y: auto;
		padding: 0.55rem 0.5rem calc(0.5rem + env(safe-area-inset-bottom));
		border-top: 0.5px solid var(--line-strong);
		border-radius: 12px 12px 0 0;
		background: var(--panel);
		color: var(--text);
		animation: rise 0.2s ease-out;
	}
	.sheet .grip {
		justify-self: center;
		width: 2rem;
		height: 4px;
		border-radius: 2px;
		background: var(--line-strong);
	}
	.sheet h3 {
		margin: 0.7rem 0.75rem 0.3rem;
		color: var(--muted);
		font-size: 0.85rem;
		font-weight: 600;
	}
	.sheet button {
		display: flex;
		align-items: center;
		gap: 1rem;
		width: 100%;
		min-height: 3rem;
		padding: 0 0.75rem;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--heading);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.sheet button:active {
		background: var(--panel-2);
	}
	.dot {
		display: grid;
		place-items: center;
		width: 1.25rem;
		height: 1.25rem;
		border: 2px solid var(--line-strong);
		border-radius: 50%;
	}
	.sheet [aria-checked='true'] .dot {
		border-color: var(--accent-2);
	}
	.sheet [aria-checked='true'] .dot::after {
		content: '';
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
		background: var(--accent-2);
	}
	@keyframes rise {
		from {
			transform: translateY(100%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sheet {
			animation: none;
		}
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
		color: var(--link);
	}
</style>
