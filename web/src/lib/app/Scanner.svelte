<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../i18n.svelte';
	import { decodeQr, parseScanned, type Scanned } from '../qr';

	let {
		accept,
		onresult,
		onclose
	}: { accept: 'link' | 'to'; onresult: (scanned: Scanned) => void; onclose: () => void } = $props();

	let video = $state<HTMLVideoElement | null>(null);
	let closeButton = $state<HTMLButtonElement | null>(null);
	let notice = $state('');
	let camera = $state(false);

	let stream: MediaStream | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const FRAME_MS = 200;
	const MAX_SIDE = 1600;

	/** Checks the decoded text against our two formats; returns false (with a notice) when it is not ours. */
	function handle(text: string | null): boolean {
		if (text === null) return false;
		const scanned = parseScanned(text);
		if (!scanned) {
			notice = t('scan_foreign');
			return false;
		}
		if (scanned.kind !== accept) {
			notice = t(scanned.kind === 'link' ? 'scan_is_link' : 'scan_is_contact');
			return false;
		}
		stop();
		onresult(scanned);
		return true;
	}

	function stop(): void {
		stopped = true;
		clearTimeout(timer);
		stream?.getTracks().forEach((track) => track.stop());
		stream = null;
		camera = false;
	}

	function frame(): void {
		if (stopped || !video) return;
		const canvas = document.createElement('canvas');
		const scale = Math.min(1, 800 / Math.max(video.videoWidth, 1));
		canvas.width = Math.round(video.videoWidth * scale);
		canvas.height = Math.round(video.videoHeight * scale);
		if (canvas.width > 0) {
			const context = canvas.getContext('2d', { willReadFrequently: true });
			context?.drawImage(video, 0, 0, canvas.width, canvas.height);
			const image = context?.getImageData(0, 0, canvas.width, canvas.height);
			if (image) {
				void decodeQr(image).then((text) => {
					if (!stopped && !handle(text)) timer = setTimeout(frame, FRAME_MS);
				});
				return;
			}
		}
		timer = setTimeout(frame, FRAME_MS);
	}

	async function startCamera(): Promise<void> {
		if (!navigator.mediaDevices?.getUserMedia) {
			notice = window.isSecureContext ? t('scan_no_camera') : t('scan_insecure');
			return;
		}
		try {
			const opened = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: 'environment' } },
				audio: false
			});
			if (stopped) {
				opened.getTracks().forEach((track) => track.stop());
				return;
			}
			stream = opened;
			camera = true;
			await Promise.resolve();
			if (video) {
				video.srcObject = opened;
				await video.play();
			}
			frame();
		} catch (error) {
			stop();
			stopped = false;
			const denied = error instanceof DOMException && error.name === 'NotAllowedError';
			notice = t(denied ? 'scan_denied' : 'scan_no_camera');
		}
	}

	async function fromFile(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		try {
			const bitmap = await createImageBitmap(file);
			const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const context = canvas.getContext('2d', { willReadFrequently: true });
			context?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			bitmap.close();
			const image = context?.getImageData(0, 0, canvas.width, canvas.height);
			const text = image ? await decodeQr(image) : null;
			if (text === null) notice = t('scan_none');
			else handle(text);
		} catch {
			notice = t('scan_none');
		}
	}

	function close(): void {
		stop();
		onclose();
	}

	onMount(() => {
		closeButton?.focus();
		void startCamera();
		return stop;
	});
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => e.target === e.currentTarget && close()}>
	<div class="panel" role="dialog" aria-modal="true" aria-labelledby="scan-title">
		<h2 id="scan-title">{t('scan_title')}</h2>
		<p class="hint">{t(accept === 'link' ? 'scan_help_link' : 'scan_help_to')}</p>
		{#if camera}
			<!-- svelte-ignore a11y_media_has_caption -->
			<video bind:this={video} playsinline muted></video>
		{/if}
		{#if notice}<p class="notice" role="status">{notice}</p>{/if}
		<label class="file">
			<span>{t('scan_file')}</span>
			<input type="file" accept="image/*" onchange={fromFile} />
		</label>
		<button type="button" bind:this={closeButton} onclick={close}>{t('cancel')}</button>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		padding: 1rem;
		background: color-mix(in srgb, var(--bg) 70%, transparent);
	}
	.panel {
		display: grid;
		gap: 0.8rem;
		width: 100%;
		max-width: 26rem;
		padding: 1.25rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius-lg);
		background: var(--panel-2);
	}
	h2 {
		margin: 0;
		color: var(--heading);
		font-size: 1.05rem;
	}
	p {
		margin: 0;
	}
	.hint {
		color: var(--muted);
		font-size: 0.85rem;
	}
	.notice {
		color: var(--accent-2);
		font-size: 0.85rem;
	}
	video {
		width: 100%;
		max-height: 60vh;
		border-radius: var(--radius);
		background: #000;
		object-fit: cover;
	}
	button {
		padding: 0.5rem 0.9rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: transparent;
		color: var(--accent-2);
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
	}
	button:hover {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-ink);
	}
	.file {
		display: grid;
	}
	/* The real input stays in the page (and keyboard-reachable) but looks like the other buttons. */
	.file input {
		grid-area: 1 / 1;
		width: 100%;
		height: 100%;
		opacity: 0;
		cursor: pointer;
	}
	.file span {
		grid-area: 1 / 1;
		display: grid;
		place-items: center;
		min-height: 2.5rem;
		padding: 0 0.9rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		color: var(--text);
		text-align: center;
		pointer-events: none;
	}
	.file:focus-within span {
		border-color: var(--accent);
	}
</style>
