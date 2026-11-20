<script lang="ts">
	// Settings > Notifications: keep MIGA connected while its window is closed (desktop tray) or the app is in
	// the background (Android service). Shown only where the platform can do it.
	import { platform } from '../platform';
	import { t } from '../i18n.svelte';

	const control = platform.background;
	let ready = $state(false);
	let available = $state(false);
	let on = $state(true);

	async function load(): Promise<void> {
		if (!control) return;
		const s = await control.state();
		available = s.available;
		on = s.on;
		ready = true;
	}
	void load();

	async function change(next: boolean): Promise<void> {
		on = next;
		try {
			await control?.set(next);
		} finally {
			await load();
		}
	}
</script>

{#if control && ready}
	{#if available}
		<label class="check">
			<input type="checkbox" checked={on} onchange={(e) => change(e.currentTarget.checked)} data-bg-toggle={control.kind} />
			<span>{control.kind === 'tray' ? t('bg_tray_label') : t('bg_service_label')}</span>
		</label>
		<p class="hint">{control.kind === 'tray' ? t('bg_tray_note') : t('bg_service_note')}</p>
		{#if control.batteryExemption && on}
			<button type="button" class="quiet" onclick={() => control.batteryExemption?.()}>{t('bg_battery')}</button>
		{/if}
	{:else}
		<p class="hint">{t('bg_tray_unavailable')}</p>
	{/if}
{/if}

<style>
	.check {
		display: flex;
		align-items: flex-start;
		gap: 0.55rem;
		color: var(--text);
		font-size: 0.85rem;
		cursor: pointer;
		margin-top: 0.9rem;
	}
	.check input {
		flex: none;
		width: 1rem;
		height: 1rem;
		margin: 0.2rem 0 0;
		padding: 0;
		accent-color: var(--accent);
	}
	.hint {
		margin: 0.5rem 0 0;
		color: var(--dim);
		font-size: 0.78rem;
	}
	button.quiet {
		margin-top: 0.6rem;
		padding: 0.5rem 0.8rem;
		background: transparent;
		color: var(--accent);
		border: 1px solid var(--line, currentColor);
		border-radius: 0.5rem;
		font: inherit;
		font-size: 0.8rem;
		cursor: pointer;
	}
</style>
