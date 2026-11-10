<script lang="ts">
	// Self-hosted font: no request to a third-party font service.
	import '@fontsource-variable/jetbrains-mono/wght.css';
	import { onMount } from 'svelte';
	import { initLanguage } from '../lib/i18n.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	onMount(initLanguage);
</script>

{@render children()}

<style>
	/* Design tokens shared with vniverse77.com so the two sites read as one family. */
	:global(:root) {
		--bg: #070b14;
		--panel: #0d1525;
		--panel-2: #13203a;
		--line: rgba(26, 107, 191, 0.2);
		--line-strong: rgba(55, 138, 221, 0.45);
		--text: #c8d8f0;
		--heading: #e8f0fe;
		--muted: #8fa6c4;
		--dim: #4a7ab5;
		--accent: #1a6bbf;
		--accent-2: #378add;
		--accent-ink: #ffffff;
		--mine: #123a66;
		--danger: #f0766b;
		--radius: 6px;
		--radius-lg: 12px;
		color-scheme: dark;
	}
	/* Dark is the default, as on vniverse77.com. Light applies only when asked for explicitly. */
	:global(:root[data-theme='light']) {
		--bg: #f0f4ff;
		--panel: #e0eaff;
		--panel-2: #cfdcf7;
		--line: rgba(24, 95, 165, 0.2);
		--line-strong: rgba(24, 95, 165, 0.45);
		--text: #0d1525;
		--heading: #0d1525;
		--muted: #37506e;
		--dim: #3a6a9a;
		--accent: #185fa5;
		--accent-2: #378add;
		--mine: #b9d3f5;
		--danger: #b3261e;
		color-scheme: light;
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
			15px/1.6 'JetBrains Mono Variable',
			'JetBrains Mono',
			ui-monospace,
			'Cascadia Mono',
			Menlo,
			Consolas,
			monospace;
		overflow-x: hidden;
	}
	:global(a) {
		color: var(--accent-2);
	}
	:global(button, input, textarea) {
		font: inherit;
		color: inherit;
	}
	:global(:focus-visible) {
		outline: 2px solid var(--accent-2);
		outline-offset: 2px;
	}
</style>
