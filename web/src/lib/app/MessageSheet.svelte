<script lang="ts">
	// Touch: the actions of one message as a modal bottom sheet. Scrim tap, Esc, Back (the page closes it)
	// and a swipe down on the handle all close it. Mouse users get the small menu in Messenger.svelte instead.
	import Icon from './Icon.svelte';
	import { t } from '../i18n.svelte';

	type Action = { icon: 'reply' | 'copy' | 'edit' | 'trash' | 'pin' | 'pin-off' | 'bell' | 'bell-off'; label: string; danger?: boolean; run: () => void };
	let { preview, actions, onclose }: { preview: string; actions: Action[]; onclose: () => void } = $props();

	let sheet = $state<HTMLElement | null>(null);
	// The click that ends the long-press must not hit the scrim that just appeared under the finger.
	const openedAt = Date.now();
	const scrimClick = () => Date.now() - openedAt > 400 && onclose();
	let drag = $state<{ id: number; y0: number; dy: number } | null>(null);

	$effect(() => {
		sheet?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
	});

	function down(e: PointerEvent): void {
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		drag = { id: e.pointerId, y0: e.clientY, dy: 0 };
	}
	function move(e: PointerEvent): void {
		if (drag && e.pointerId === drag.id) drag = { ...drag, dy: Math.max(0, e.clientY - drag.y0) };
	}
	function up(e: PointerEvent): void {
		if (!drag || e.pointerId !== drag.id) return;
		const far = drag.dy > Math.min(96, (sheet?.offsetHeight ?? 300) / 3);
		drag = null;
		if (far) onclose();
	}
</script>

<div class="scrim" role="presentation" onclick={scrimClick}></div>
<div
	class="sheet"
	class:dragging={!!drag}
	role="dialog"
	aria-modal="true"
	aria-label={t('msg_actions')}
	bind:this={sheet}
	style:transform={drag ? `translateY(${drag.dy}px)` : undefined}
>
	<div class="head" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={() => (drag = null)} role="presentation">
		<span class="grip"></span>
		{#if preview}<p>{preview}</p>{/if}
	</div>
	<div class="list" role="menu">
		{#each actions as a (a.label)}
			<button type="button" role="menuitem" class:danger={a.danger} onclick={a.run}>
				<Icon name={a.icon} size={20} />{a.label}
			</button>
		{/each}
	</div>
</div>

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 95;
		background: rgba(0, 0, 0, 0.5);
		animation: fade 0.15s ease-out;
	}
	.sheet {
		position: fixed;
		right: 0;
		bottom: 0;
		left: 0;
		z-index: 96;
		display: grid;
		max-height: 80dvh;
		padding-bottom: env(safe-area-inset-bottom);
		border-top: 0.5px solid var(--line-strong);
		border-radius: 12px 12px 0 0;
		background: var(--panel);
		color: var(--text);
		animation: rise 0.2s ease-out;
	}
	.sheet.dragging {
		animation: none;
		transition: none;
	}
	.head {
		display: grid;
		gap: 0.6rem;
		padding: 0.55rem 1rem 0.5rem;
		touch-action: none;
	}
	.grip {
		justify-self: center;
		width: 2rem;
		height: 4px;
		border-radius: 2px;
		background: var(--line-strong);
	}
	.head p {
		margin: 0;
		padding: 0.25rem 0.6rem;
		border-left: 3px solid var(--accent-2);
		border-radius: 6px;
		background: var(--bg);
		color: var(--muted);
		font-size: 0.85em;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.list {
		display: grid;
		padding: 0 0.5rem 0.5rem;
	}
	.list button {
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
	.list button :global(.icon) {
		color: var(--muted);
	}
	.list button:active {
		background: var(--panel-2);
	}
	.list button.danger,
	.list button.danger :global(.icon) {
		color: var(--danger);
	}
	@keyframes rise {
		from {
			transform: translateY(100%);
		}
	}
	@keyframes fade {
		from {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sheet,
		.scrim {
			animation: none;
		}
	}
</style>
