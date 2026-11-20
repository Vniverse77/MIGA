<script lang="ts">
	// A link preview card: small picture, title, site. Compact on a phone. Used under a message (opens the link)
	// and above the composer (with a remove icon). It only shows what the sender put in the message; it never
	// loads anything from the website itself.
	import { onDestroy } from 'svelte';
	import { fetchMedia } from '../media';
	import type { Preview } from '../preview';
	import { platform } from '../platform';
	import { t } from '../i18n.svelte';
	import Icon from './Icon.svelte';

	let { preview, src = '', onremove }: { preview: Preview; src?: string; onremove?: () => void } = $props();

	let url = $state('');
	let current = '';
	$effect(() => {
		const img = preview.img;
		let live = true;
		if (!img || src) return;
		fetchMedia(img).then(
			(blob) => {
				if (!live) return;
				if (current) URL.revokeObjectURL(current);
				current = URL.createObjectURL(blob);
				url = current;
			},
			() => {}
		);
		return () => {
			live = false;
		};
	});
	onDestroy(() => current && URL.revokeObjectURL(current));

	const shown = $derived(src || url);
	const host = $derived.by(() => {
		try {
			return new URL(preview.url).hostname.replace(/^www\./, '');
		} catch {
			return '';
		}
	});
</script>

<div class="card" class:removable={!!onremove}>
	<button
		type="button"
		class="open"
		title={t('linkprev_open')}
		aria-label={`${t('linkprev_open')}: ${preview.title || host}`}
		onclick={() => platform.openExternal(preview.url)}
	>
		{#if shown}
			<img class="pic" src={shown} alt="" draggable="false" />
		{:else}
			<span class="pic ph" aria-hidden="true"><Icon name="link" size={20} /></span>
		{/if}
		<span class="text">
			<strong>{preview.title || preview.site || host}</strong>
			{#if preview.desc}<span class="desc">{preview.desc}</span>{/if}
			<span class="site">{preview.site || host}</span>
		</span>
	</button>
	{#if onremove}
		<button type="button" class="x" title={t('linkprev_remove')} aria-label={t('linkprev_remove')} onclick={onremove}>
			<Icon name="close" size={16} />
		</button>
	{/if}
</div>

<style>
	.card {
		display: flex;
		align-items: stretch;
		min-width: 0;
		max-width: 100%;
		border: 0.5px solid var(--line);
		border-left: 3px solid var(--accent-2);
		border-radius: 10px;
		background: var(--panel-2, var(--panel));
		color: var(--text, inherit);
		overflow: hidden;
	}
	.open {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: stretch;
		gap: 0.6rem;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.pic {
		flex: none;
		width: 4.25rem;
		min-height: 4.25rem;
		object-fit: cover;
		background: var(--panel);
	}
	.ph {
		display: grid;
		place-content: center;
		color: var(--muted);
	}
	.text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.1rem;
		padding: 0.4rem 0.6rem 0.4rem 0;
		font-size: 0.85em;
	}
	.pic + .text,
	.ph + .text {
		padding-left: 0;
	}
	.card:not(:has(.pic)) .text {
		padding-left: 0.6rem;
	}
	strong,
	.desc {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	strong {
		-webkit-line-clamp: 2;
		line-clamp: 2;
		line-height: 1.25;
	}
	.desc {
		-webkit-line-clamp: 2;
		line-clamp: 2;
		color: var(--muted);
		font-size: 0.92em;
		line-height: 1.3;
	}
	.removable .desc {
		-webkit-line-clamp: 1;
		line-clamp: 1;
	}
	.removable .pic {
		width: 3.5rem;
		min-height: 3.5rem;
	}
	.site {
		color: var(--muted);
		font-size: 0.85em;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.x {
		flex: none;
		width: 2.5rem;
		display: grid;
		place-content: center;
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
	}
	.x:hover {
		color: var(--text, inherit);
	}
	.open:focus-visible,
	.x:focus-visible {
		outline: 2px solid var(--accent-2);
		outline-offset: -2px;
	}
</style>
