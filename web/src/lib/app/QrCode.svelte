<script lang="ts">
	import { qrSvg } from '../qr';

	let { text, label }: { text: string; label: string } = $props();
	// The SVG is generated here from numbers only; the text itself never ends up in the markup.
	const svg = $derived(qrSvg(text));
</script>

<div class="qr" role="img" aria-label={label}>{@html svg}</div>

<style>
	.qr {
		justify-self: center;
		width: min(100%, 17rem);
		line-height: 0;
		border-radius: var(--radius);
		overflow: hidden;
		/* Always dark on light, in every theme: scanners need the contrast. */
		background: #fff;
	}
	.qr :global(svg) {
		display: block;
		width: 100%;
		height: auto;
	}
</style>
