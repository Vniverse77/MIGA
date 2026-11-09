<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

<style>
	:global(:root) {
		--bg: #0e1116;
		--panel: #161b22;
		--panel-2: #1f2630;
		--line: #2b3440;
		--text: #e6edf3;
		--muted: #8b98a8;
		--accent: #3fb6a8;
		--accent-ink: #06211e;
		--danger: #f0766b;
		color-scheme: dark;
	}
	:global(*) {
		box-sizing: border-box;
	}
	:global(html, body) {
		height: 100%;
		margin: 0;
	}
	:global(body) {
		background: var(--bg);
		color: var(--text);
		font:
			16px/1.5 system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
	}
	:global(a) {
		color: var(--accent);
	}
	:global(button, input, textarea) {
		font: inherit;
		color: inherit;
	}
</style>
