<script lang="ts">
	import { t } from '../i18n.svelte';
	import { clipboardAvailable, copyText } from '../clipboard';

	let { text }: { text: string } = $props();
	let done = $state(false);
	let failed = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		if (await copyText(text)) {
			failed = false;
			done = true;
			clearTimeout(timer);
			timer = setTimeout(() => (done = false), 1600);
		} else {
			// Blocked (plain http, no permission): the text stays selectable; say so instead of a silent click.
			done = false;
			failed = true;
			clearTimeout(timer);
			timer = setTimeout(() => (failed = false), 4000);
		}
	}
	const label = $derived(done ? t('dl_copied') : failed ? (clipboardAvailable() ? t('n_copy_failed') : t('n_copy_insecure')) : t('dl_copy'));
</script>

<button type="button" class="copy-btn" class:done class:failed aria-live="polite" aria-label={label} title={label} onclick={copy}>
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
	.copy-btn.failed {
		border-color: var(--danger, #d9534f);
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
