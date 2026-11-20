<script lang="ts">
	// Square crop for the profile photo: drag to move, slider or wheel to zoom. The result is 256x256,
	// re-encoded on a canvas (no EXIF), and never leaves the device until it is shared encrypted.
	import { onMount } from 'svelte';
	import { t } from '../i18n.svelte';
	import { drawCrop, encodeCrop, type View } from '../photo';
	import Icon from './Icon.svelte';
	import Sheet from './Sheet.svelte';

	let { bitmap, onsave, oncancel }: { bitmap: ImageBitmap; onsave: (blob: Blob, hash: string) => void; oncancel: () => void } = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let view = $state<View>({ zoom: 1, x: 0, y: 0 });
	let busy = $state(false);
	let drag: { id: number; px: number; py: number } | null = null;

	const SHOW = 240;
	const draw = () => canvas && drawCrop(canvas, bitmap, view, SHOW);
	$effect(() => {
		void view.zoom, view.x, view.y;
		draw();
	});
	onMount(draw);

	// Pixels of free room along each axis at the current zoom, so a drag of N px moves the picture by N px.
	function room(): { rx: number; ry: number } {
		const side = Math.min(bitmap.width, bitmap.height) / view.zoom;
		const k = SHOW / side;
		return { rx: ((bitmap.width - side) * k) / 2, ry: ((bitmap.height - side) * k) / 2 };
	}
	const clamp = (n: number) => Math.min(1, Math.max(-1, n));

	function down(e: PointerEvent): void {
		drag = { id: e.pointerId, px: e.clientX, py: e.clientY };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function move(e: PointerEvent): void {
		if (!drag || drag.id !== e.pointerId) return;
		const { rx, ry } = room();
		// Dragging the picture right moves the window left.
		if (rx > 0) view.x = clamp(view.x - (e.clientX - drag.px) / rx);
		if (ry > 0) view.y = clamp(view.y - (e.clientY - drag.py) / ry);
		drag.px = e.clientX;
		drag.py = e.clientY;
	}
	const up = () => (drag = null);
	function wheel(e: WheelEvent): void {
		e.preventDefault();
		view.zoom = Math.min(8, Math.max(1, view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
	}
	function key(e: KeyboardEvent): void {
		const step = 0.1;
		if (e.key === 'ArrowLeft') view.x = clamp(view.x - step);
		else if (e.key === 'ArrowRight') view.x = clamp(view.x + step);
		else if (e.key === 'ArrowUp') view.y = clamp(view.y - step);
		else if (e.key === 'ArrowDown') view.y = clamp(view.y + step);
		else return;
		e.preventDefault();
	}

	async function save(): Promise<void> {
		busy = true;
		try {
			const out = await encodeCrop(bitmap, view);
			onsave(out.blob, out.hash);
		} catch {
			busy = false;
		}
	}
</script>

<Sheet title={t('photo_crop_title')} onclose={oncancel} {busy}>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions, a11y_no_interactive_element_to_noninteractive_role -->
	<canvas
		bind:this={canvas}
		class="crop"
		width={SHOW}
		height={SHOW}
		tabindex="0"
		role="img"
		aria-label={t('photo_crop_help')}
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
		onwheel={wheel}
		onkeydown={key}
	></canvas>
	<label class="zoom">
		<Icon name="search" size={16} />
		<input type="range" min="1" max="4" step="0.01" bind:value={view.zoom} aria-label={t('photo_zoom')} />
	</label>
	<div class="crop-actions">
		<button type="button" class="primary" title={t('photo_save')} aria-label={t('photo_save')} onclick={save} disabled={busy}><Icon name="check" size={20} /></button>
	</div>
</Sheet>

<style>
	.crop {
		justify-self: center;
		width: min(15rem, 100%);
		aspect-ratio: 1;
		border: 0.5px solid var(--line-strong);
		border-radius: 50%;
		background: var(--panel);
		cursor: grab;
		touch-action: none;
	}
	.crop:active {
		cursor: grabbing;
	}
	.zoom {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		color: var(--muted);
	}
	.zoom input {
		flex: 1;
		min-width: 0;
		accent-color: var(--link);
	}
	.crop-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
	.crop-actions button {
		display: grid;
		place-items: center;
		width: 2.8rem;
		height: 2.4rem;
		padding: 0;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: transparent;
		color: var(--link);
		cursor: pointer;
	}
	.crop-actions button:hover:not(:disabled) {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-ink);
	}
	.crop-actions button.primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-ink);
	}
	.crop-actions button:disabled {
		opacity: 0.5;
	}
</style>
