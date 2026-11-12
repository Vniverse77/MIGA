<script module lang="ts">
	export type AskOptions = {
		title?: string;
		body: string;
		confirm: string;
		danger?: boolean;
		/** When set, the dialog shows a text field with this placeholder. */
		placeholder?: string;
	};

	let pending = $state<{ options: AskOptions; resolve: (ok: boolean, value: string) => void } | null>(null);
	let value = $state('');

	/** Shows the in-app confirmation dialog. Resolves true on confirm, false on cancel or Esc. */
	export function ask(options: AskOptions): Promise<boolean> {
		pending?.resolve(false, '');
		return new Promise((resolve) => {
			value = '';
			pending = { options, resolve: (ok) => resolve(ok) };
		});
	}

	/** Same dialog with a text field. Resolves the typed text, or null on cancel or Esc. */
	export function askText(options: AskOptions & { placeholder: string }): Promise<string | null> {
		pending?.resolve(false, '');
		return new Promise((resolve) => {
			value = '';
			pending = { options, resolve: (ok, text) => resolve(ok ? text : null) };
		});
	}
</script>

<script lang="ts">
	import { t } from '../i18n.svelte';
	import { platform } from '../platform';

	let field = $state<HTMLInputElement | null>(null);
	let cancelButton = $state<HTMLButtonElement | null>(null);
	let confirmButton = $state<HTMLButtonElement | null>(null);

	let opener: HTMLElement | null = null;

	function close(ok: boolean): void {
		const current = pending;
		pending = null;
		const back = opener;
		opener = null;
		if (back?.isConnected) queueMicrotask(() => back.focus());
		current?.resolve(ok, value);
	}

	$effect(() => {
		if (pending) {
			if (!opener && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
				opener = document.activeElement;
			}
			(field ?? cancelButton)?.focus();
		}
	});

	function onkeydown(event: KeyboardEvent): void {
		if (!pending) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			close(false);
		} else if (event.key === 'Tab') {
			// Keep focus inside the dialog.
			event.preventDefault();
			const order = [field, cancelButton, confirmButton].filter((x) => x !== null);
			const at = order.findIndex((x) => x === document.activeElement);
			const step = event.shiftKey ? -1 : 1;
			order[(at + step + order.length) % order.length]?.focus();
		}
	}
</script>

<svelte:window {onkeydown} />

{#if pending}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={(e) => e.target === e.currentTarget && close(false)}>
		<div class="panel" class:desktop={platform.target === 'desktop'} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
			<h2 id="confirm-title">{pending.options.title ?? t('confirm_title')}</h2>
			<p id="confirm-body">{pending.options.body}</p>
			{#if pending.options.placeholder !== undefined}
				<input
					bind:this={field}
					bind:value
					placeholder={pending.options.placeholder}
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), close(true))}
				/>
			{/if}
			<div class="actions">
				<button type="button" bind:this={cancelButton} onclick={() => close(false)}>{t('cancel')}</button>
				<button
					type="button"
					class={pending.options.danger ? 'danger' : 'primary'}
					bind:this={confirmButton}
					onclick={() => close(true)}
				>
					{pending.options.confirm}
				</button>
			</div>
		</div>
	</div>
{/if}

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
		color: var(--text);
		font-size: 0.9rem;
		overflow-wrap: anywhere;
		white-space: pre-line;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		margin-top: 0.4rem;
	}
	input {
		width: 100%;
		padding: 0.6rem 0.75rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
		font-size: 0.9rem;
	}
	input::placeholder {
		color: var(--dim);
	}
	input:focus {
		border-color: var(--accent-2);
		outline: none;
	}
	button {
		padding: 0.5rem 1rem;
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
	button:focus-visible {
		outline: 1px solid var(--accent-2);
		outline-offset: 2px;
	}
	button.primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-ink);
	}
	button.danger {
		border-color: var(--danger);
		color: var(--danger);
	}
	button.danger:hover {
		background: var(--danger);
		color: var(--bg);
	}
	.panel.desktop {
		gap: 0.6rem;
		max-width: 24rem;
		padding: 1rem;
		border-radius: 8px;
	}
	.panel.desktop h2 {
		font-size: 0.95rem;
	}
	.panel.desktop p,
	.panel.desktop input,
	.panel.desktop button {
		font-size: 13px;
	}
	.panel.desktop button {
		min-height: 0;
		height: 28px;
		padding: 0 0.8rem;
		border-radius: 6px;
	}
	.panel.desktop input {
		height: 32px;
		padding: 0 0.65rem;
		border-radius: 6px;
	}
	@media (max-width: 760px) {
		button {
			min-height: 2.75rem;
		}
		input {
			font-size: 16px;
		}
	}
</style>
