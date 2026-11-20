<script lang="ts">
	import { t } from '../i18n.svelte';

	let { text }: { text: string } = $props();
	let done = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			done = true;
			clearTimeout(timer);
			timer = setTimeout(() => (done = false), 1600);
		} catch {
			/* clipboard blocked: the text stays selectable */
		}
	}
	const label = $derived(done ? t('dl_copied') : t('dl_copy'));
</script>

<button type="button" class="copy-btn" class:done aria-label={label} title={label} onclick={copy}>
	<svg viewBox="0 0 24 24" aria-hidden="true">
		{#if done}
			<path d="M5 12.5l4.5 4.5L19 7.5" />
		{:else}
			<rect x="9" y="9" width="11" height="11" rx="2" />
			<path d="M5 15V6a2 2 0 0 1 2-2h8" />
		{/if}
	</svg>
</button>

<style>
	.copy-btn {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 2.75rem;
		min-height: 2.75rem;
		padding: 0;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: transparent;
		color: var(--link);
		cursor: pointer;
		transition:
			background-color 0.2s ease,
			color 0.2s ease;
	}
	.copy-btn:hover,
	.copy-btn.done {
		background: var(--accent);
		color: var(--accent-ink);
	}
	svg {
		width: 1.2rem;
		height: 1.2rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.7;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
