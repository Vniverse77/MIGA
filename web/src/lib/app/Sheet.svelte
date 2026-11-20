<script module lang="ts">
	// Open sheets, topmost last. Messenger asks here so the Android Back gesture closes the top one.
	let stack = $state<(() => void)[]>([]);
	export const sheetOpen = (): boolean => stack.length > 0;
	/** Closes the topmost sheet (system Back). A sheet that is busy ignores it. */
	export function dismissSheet(): void {
		stack.at(-1)?.();
	}
</script>

<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { t } from '../i18n.svelte';
	import { platform } from '../platform';
	import Icon from './Icon.svelte';

	let {
		title,
		onclose,
		busy = false,
		tone = 'normal',
		children
	}: { title: string; onclose: () => void; busy?: boolean; tone?: 'normal' | 'danger'; children: Snippet } = $props();

	let panel = $state<HTMLElement | null>(null);
	let opener: HTMLElement | null = null;

	function close(): void {
		if (!busy) onclose();
	}

	onMount(() => {
		opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		stack.push(close);
		panel?.querySelector<HTMLElement>('[data-autofocus], input, button')?.focus({ preventScroll: true });
		return () => {
			stack = stack.filter((fn) => fn !== close);
			if (opener?.isConnected) opener.focus({ preventScroll: true });
		};
	});

	function onkeydown(event: KeyboardEvent): void {
		// Only the topmost sheet reacts, and a dialog opened above it (confirm, scanner) keeps its own keys.
		if (stack.at(-1) !== close || [...document.querySelectorAll('[aria-modal="true"]')].at(-1) !== panel) return;
		if (event.key === 'Escape' && !event.defaultPrevented) {
			event.preventDefault();
			close();
		} else if (event.key === 'Tab' && panel) {
			const focusable = [...panel.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex="0"]')].filter(
				(el) => !el.hasAttribute('disabled') && el.offsetParent !== null
			);
			if (!focusable.length) return;
			const at = focusable.indexOf(document.activeElement as HTMLElement);
			const next = event.shiftKey ? (at <= 0 ? focusable.length - 1 : at - 1) : at === focusable.length - 1 ? 0 : at + 1;
			event.preventDefault();
			focusable[next].focus();
		}
	}
</script>

<svelte:window {onkeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && close()}>
	<div bind:this={panel} class="panel" class:danger={tone === 'danger'} class:desktop={platform.target === 'desktop'} role="dialog" aria-modal="true" aria-labelledby="sheet-title">
		<span class="grip"></span>
		<header>
			<h2 id="sheet-title">{title}</h2>
			<button type="button" class="x" aria-label={t('close')} title={t('close')} disabled={busy} onclick={close}><Icon name="close" size={18} /></button>
		</header>
		<div class="body">{@render children()}</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 90;
		display: grid;
		place-items: center;
		padding: 1rem;
		overflow-y: auto;
		background: rgba(0, 0, 0, 0.55);
		animation: fade 0.15s ease-out;
	}
	.panel {
		display: grid;
		gap: 0.7rem;
		width: 100%;
		max-width: 28rem;
		max-height: calc(100dvh - 2rem);
		padding: 1.1rem 1.25rem 1.25rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius-lg);
		background: var(--panel-2);
		overflow-y: auto;
		overscroll-behavior: contain;
		color: var(--text);
	}
	.panel.danger {
		border-color: var(--danger);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
	}
	h2 {
		margin: 0;
		color: var(--heading);
		font-size: 1.05rem;
	}
	.x {
		display: grid;
		place-items: center;
		flex: none;
		width: 2rem;
		height: 2rem;
		margin-right: -0.4rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}
	.x:hover:not(:disabled) {
		color: var(--text);
		background: var(--panel);
	}
	.x:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.body {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
	}
	.grip {
		display: none;
	}
	.panel.desktop {
		gap: 0.55rem;
		padding: 0.9rem 1rem 1rem;
	}
	.panel.desktop h2 {
		font-size: 0.95rem;
	}
	@keyframes fade {
		from {
			opacity: 0;
		}
	}
	@keyframes rise {
		from {
			transform: translateY(100%);
		}
	}
	/* Touch: a bottom sheet, like the confirm dialog and the message menu. */
	@media (hover: none), (pointer: coarse) {
		.backdrop {
			place-items: end stretch;
			padding: 0;
		}
		.panel,
		.panel.desktop {
			gap: 0.6rem;
			max-width: none;
			max-height: 92dvh;
			padding: 0.55rem 1.1rem calc(1rem + env(safe-area-inset-bottom));
			border-width: 0.5px 0 0;
			border-radius: 12px 12px 0 0;
			background: var(--panel);
			animation: rise 0.2s ease-out;
		}
		.panel.desktop h2,
		h2 {
			font-size: 1.05rem;
		}
		.grip {
			display: block;
			justify-self: center;
			width: 2rem;
			height: 4px;
			border-radius: 2px;
			background: var(--line-strong);
		}
	}

	/* Shared look of what the backup and restore sheets put inside. */
	.body :global(.lead),
	.body :global(.hint) {
		margin: 0;
		color: var(--muted);
		font-size: var(--fs-small);
		line-height: 1.5;
	}
	.body :global(.lead) {
		color: var(--text);
		font-size: 0.88rem;
	}
	.body :global(.btn) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		min-height: 2.5rem;
		padding: 0 1rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: transparent;
		color: var(--link);
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
	}
	.body :global(.btn:hover:not(:disabled)) {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-ink);
	}
	.body :global(.btn.primary) {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-ink);
	}
	.body :global(.btn.primary:hover:not(:disabled)) {
		background: var(--accent-2);
		border-color: var(--accent-2);
	}
	.body :global(.btn.danger) {
		border-color: var(--danger);
		color: var(--danger);
	}
	.body :global(.btn.danger:hover:not(:disabled)) {
		background: var(--danger);
		color: var(--bg);
	}
	.body :global(.btn:disabled) {
		opacity: 0.45;
		cursor: default;
	}
	.body :global(.actions) {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		margin-top: 0.2rem;
	}
	.body :global(.opt) {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.75rem 0.8rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius-lg);
		background: var(--bg);
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}
	.body :global(.opt:hover) {
		border-color: var(--accent-2);
	}
	.body :global(.opt strong) {
		display: block;
		color: var(--heading);
		font-size: 0.9rem;
		font-weight: 600;
	}
	.body :global(.opt small) {
		display: block;
		margin-top: 0.1rem;
		color: var(--muted);
		font-size: var(--fs-small);
		line-height: 1.4;
	}
	.body :global(.opt .glyph) {
		display: grid;
		place-items: center;
		width: 2.2rem;
		height: 2.2rem;
		border-radius: var(--radius);
		background: var(--panel-2);
		color: var(--accent-2);
	}
	.body :global(.check) {
		display: grid;
		grid-template-columns: auto 1fr;
		align-items: start;
		gap: 0.6rem;
		color: var(--text);
		font-size: 0.85rem;
		cursor: pointer;
	}
	.body :global(.check input) {
		width: 1.05rem;
		height: 1.05rem;
		margin: 0.15rem 0 0;
		accent-color: var(--accent);
	}
	.body :global(.check small) {
		display: block;
		color: var(--muted);
		font-size: var(--fs-small);
		line-height: 1.4;
	}
	.body :global(.warn) {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.65rem;
		padding: 0.7rem 0.8rem;
		border: 0.5px solid var(--danger);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--danger) 9%, transparent);
		color: var(--text);
		font-size: var(--fs-small);
		line-height: 1.5;
	}
	.body :global(.warn p) {
		margin: 0;
	}
	.body :global(.warn .icon) {
		margin-top: 0.1rem;
		color: var(--danger);
	}
	.body :global(.error) {
		margin: 0;
		color: var(--danger);
		font-size: var(--fs-small);
	}
	.body :global(.done) {
		display: grid;
		justify-items: center;
		gap: 0.6rem;
		padding: 0.6rem 0 0.2rem;
		text-align: center;
	}
	.body :global(.done .badge) {
		display: grid;
		place-items: center;
		width: 3rem;
		height: 3rem;
		border-radius: 50%;
		background: color-mix(in srgb, var(--accent-2) 16%, transparent);
		color: var(--accent-2);
	}
	@media (max-width: 760px), (pointer: coarse) {
		.body :global(.btn) {
			min-height: 3rem;
			font-size: 0.95rem;
		}
		.body :global(.actions) {
			flex-direction: column-reverse;
		}
		.body :global(.actions .btn) {
			width: 100%;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.backdrop,
		.panel {
			animation: none !important;
		}
	}
</style>
