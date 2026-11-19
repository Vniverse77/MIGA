<script lang="ts">
	import Icon from './Icon.svelte';
	// Full-screen picture viewer: wheel and pinch zoom, drag to pan, double-click to reset, Save.
	import { onMount } from 'svelte';
	import { extFor } from '../attach';
	import { t } from '../i18n.svelte';

	let { url, mime, onclose }: { url: string; mime: string; onclose: () => void } = $props();

	let scale = $state(1);
	let x = $state(0);
	let y = $state(0);
	let closeBtn = $state<HTMLButtonElement | null>(null);
	const pointers = new Map<number, { x: number; y: number }>();
	let pinchStart = 0;
	let pinchScale = 1;
	let moved = false;

	const clamp = (v: number) => Math.min(8, Math.max(1, v));

	function zoomTo(next: number): void {
		scale = clamp(next);
		if (scale === 1) {
			x = 0;
			y = 0;
		}
	}

	function onWheel(e: WheelEvent): void {
		e.preventDefault();
		zoomTo(scale * Math.exp(-e.deltaY * 0.0015));
	}

	function down(e: PointerEvent): void {
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		moved = false;
		if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
			pinchScale = scale;
		}
	}

	function move(e: PointerEvent): void {
		const last = pointers.get(e.pointerId);
		if (!last) return;
		const dx = e.clientX - last.x;
		const dy = e.clientY - last.y;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
		if (pointers.size === 2 && pinchStart > 0) {
			const [a, b] = [...pointers.values()];
			zoomTo((pinchScale * Math.hypot(a.x - b.x, a.y - b.y)) / pinchStart);
		} else if (scale > 1) {
			x += dx;
			y += dy;
		}
	}

	function up(e: PointerEvent): void {
		pointers.delete(e.pointerId);
		if (pointers.size < 2) pinchStart = 0;
	}

	function save(): void {
		const a = document.createElement('a');
		a.href = url;
		a.download = `miga-photo.${extFor(mime)}`;
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	function onKey(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.stopPropagation();
			onclose();
		} else if (e.key === '+' || e.key === '=') zoomTo(scale * 1.25);
		else if (e.key === '-') zoomTo(scale / 1.25);
	}

	onMount(() => {
		closeBtn?.focus();
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	});
</script>

<div class="viewer" role="dialog" aria-modal="true" aria-label={t('att_img_alt')}>
	<div class="bar">
		<button type="button" class="save" onclick={save} aria-label={t('att_save')} title={t('att_save')}><Icon name="download" /></button>
		<button type="button" class="close" bind:this={closeBtn} onclick={onclose} aria-label={t('att_close')} title={t('att_close')}><Icon name="close" /></button>
	</div>
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div
		class="stage"
		onwheel={onWheel}
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
		ondblclick={() => zoomTo(scale > 1 ? 1 : 2.5)}
		onclick={(e) => {
			if (e.target === e.currentTarget && !moved) onclose();
		}}
	>
		<img src={url} alt={t('att_img_alt')} draggable="false" style:transform="translate({x}px, {y}px) scale({scale})" />
	</div>
	<p class="hint">{t('att_zoom_hint')}</p>
</div>

<style>
	.viewer {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		flex-direction: column;
		background: #08080a;
		color: #f2f2f2;
	}
	.bar {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		padding: 0.7rem 1rem;
	}
	.bar button {
		display: grid;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		min-height: 0;
		padding: 0;
		border: 0.5px solid rgba(255, 255, 255, 0.35);
		border-radius: var(--radius);
		background: rgba(255, 255, 255, 0.1);
		color: #f2f2f2;
		font: inherit;
		cursor: pointer;
	}
	.bar button:hover {
		background: rgba(255, 255, 255, 0.2);
	}
	.stage {
		flex: 1;
		display: grid;
		place-items: center;
		min-height: 0;
		overflow: hidden;
		touch-action: none;
	}
	.stage img {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		user-select: none;
		transition: transform 0.05s linear;
	}
	.hint {
		margin: 0;
		padding: 0.5rem;
		color: rgba(255, 255, 255, 0.55);
		font-size: 0.8em;
		text-align: center;
	}
</style>
