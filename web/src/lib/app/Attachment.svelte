<script lang="ts">
	// One photo / GIF / video inside a bubble: blurred thumbnail first, then the decrypted file.
	// The file comes from IndexedDB, or is downloaded, decrypted and verified; it is shown through an
	// object URL that is revoked when the component goes away.
	import { onDestroy, untrack } from 'svelte';
	import type { Att } from '../attach';
	import { AttachError, fetchMedia } from '../media';
	import { t, type MessageKey } from '../i18n.svelte';

	let { att, onview }: { att: Att; onview: (url: string, att: Att) => void } = $props();

	let url = $state('');
	let error = $state<string>('');
	let busy = $state(false);
	let attempt = $state(0);
	let current = '';
	let thumbOk = $state(false);
	let fullOk = $state(false);

	const isVideo = $derived(att.mime.startsWith('video/'));
	// Fit the box: at most 18rem wide and 20rem tall, keeping the picture's proportions.
	const ratio = $derived(att.w / att.h);

	function revoke(): void {
		if (current) URL.revokeObjectURL(current);
		current = '';
	}

	$effect(() => {
		void attempt;
		const a = att;
		let live = true;
		untrack(() => {
			error = '';
			busy = true;
		});
		fetchMedia(a).then(
			(blob) => {
				if (!live) return;
				revoke();
				current = URL.createObjectURL(blob);
				url = current;
				busy = false;
			},
			(e) => {
				if (!live) return;
				error = e instanceof AttachError ? e.code : 'network';
				busy = false;
			}
		);
		return () => {
			live = false;
		};
	});

	onDestroy(revoke);

	const errorKey = (code: string): MessageKey =>
		code === 'gone' ? 'att_gone' : code === 'corrupt' ? 'att_corrupt' : 'att_network';
</script>

<div class="att" style:aspect-ratio={ratio} style:--ratio={ratio} data-state={url ? 'ready' : error ? 'error' : 'loading'}>
	{#if att.thumb}
		<img class="thumb" class:in={thumbOk} src={att.thumb} alt="" aria-hidden="true" onload={() => (thumbOk = true)} />
	{/if}
	{#if url}
		{#if isVideo}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video class="full in" src={url} controls playsinline preload="metadata"></video>
		{:else}
			<button type="button" class="open" aria-label={t('att_open')} title={t('att_open')} onclick={() => onview(url, att)}>
				<img class="full" class:in={fullOk} src={url} alt={t('att_img_alt')} draggable="false" onload={() => (fullOk = true)} />
			</button>
		{/if}
	{:else if error}
		<div class="state" role="alert">
			<p>{t(errorKey(error))}</p>
			{#if error !== 'gone' && error !== 'corrupt'}
				<button type="button" onclick={() => attempt++}>{t('att_retry')}</button>
			{/if}
		</div>
	{:else if busy}
		<div class="state"><p>{t('att_loading')}</p></div>
	{/if}
</div>

<style>
	.att {
		position: relative;
		width: min(18rem, 100%);
		max-height: 20rem;
		overflow: hidden;
		border-radius: calc(var(--radius-lg) - 4px);
		background: color-mix(in srgb, var(--panel-2) 100%, var(--line) 0%);
		/* Wide pictures stay 18rem wide; tall ones shrink so they never exceed 20rem. */
		width: min(18rem, calc(20rem * var(--ratio)), 70vw);
	}
	.thumb,
	.full {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	/* The card colour shows until a picture has loaded; each picture fades in over it, so nothing flashes black. */
	.thumb,
	.full:not(video) {
		opacity: 0;
		transition: opacity 0.18s ease-out;
	}
	.thumb.in,
	.full.in {
		opacity: 1;
	}
	.thumb {
		filter: blur(10px);
		transform: scale(1.15);
	}
	.full {
		background: transparent;
	}
	.open {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		min-height: 0;
		padding: 0;
		border: 0;
		background: none;
		cursor: zoom-in;
	}
	.state {
		position: absolute;
		inset: 0;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 0.4rem;
		padding: 0.6rem;
		background: color-mix(in srgb, var(--panel) 55%, transparent);
		color: var(--heading);
		font-size: 0.85em;
		text-align: center;
	}
	.state p {
		margin: 0;
	}
	.state button {
		min-height: 0;
		padding: 0.25rem 0.8rem;
		cursor: pointer;
	}
</style>
