<script lang="ts">
	// Self-hosted font: no request to a third-party font service.
	import '@fontsource-variable/jetbrains-mono/wght.css';
	import { onMount } from 'svelte';
	import { initLanguage, t } from '../lib/i18n.svelte';
	import { platform } from '../lib/platform';
	import { newerBuildOnServer } from '../lib/version';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// A cached copy keeps the app opening when the site cannot be reached; this tells the user when
	// the server has a newer build than the one running.
	let updateReady = $state(false);

	onMount(() => {
		platform.setupWindow();
		initLanguage();
		newerBuildOnServer().then((yes) => (updateReady = yes));
	});
</script>

{@render children()}

{#if updateReady}
	<div class="update" role="status">
		<span>{t('update_ready')}</span>
		<button type="button" onclick={() => location.reload()}>{t('update_reload')}</button>
	</div>
{/if}

<style>
	.update {
		position: fixed;
		left: 50%;
		bottom: 1rem;
		transform: translateX(-50%);
		z-index: 50;
		display: flex;
		align-items: center;
		gap: 0.8rem;
		padding: 0.5rem 0.6rem 0.5rem 0.9rem;
		background: var(--panel-2);
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius-lg);
		font-size: 0.85rem;
		max-width: calc(100vw - 2rem);
	}
	.update button {
		background: var(--accent);
		color: var(--accent-ink);
		border: 0;
		border-radius: var(--radius);
		padding: 0.3rem 0.8rem;
		cursor: pointer;
	}
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
		scrollbar-color: var(--line-strong) transparent;
		scrollbar-width: thin;
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
	/* Desktop window: behaves like an app, not a page. Text that people copy opts back in. */
	:global(html.desktop, html.desktop body) {
		overflow: hidden;
		height: 100%;
		user-select: none;
		-webkit-user-select: none;
		cursor: default;
	}
	:global(html.desktop img) {
		-webkit-user-drag: none;
		user-select: none;
		pointer-events: none;
	}
	:global(html.desktop input, html.desktop textarea, html.desktop code, html.desktop .selectable, html.desktop .selectable *) {
		user-select: text;
		-webkit-user-select: text;
		cursor: text;
	}
	:global(:focus-visible) {
		outline: 2px solid var(--accent-2);
		outline-offset: 2px;
	}
</style>
