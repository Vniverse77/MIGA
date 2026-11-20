<script module lang="ts">
	export type AskOptions = {
		title?: string;
		body: string;
		confirm: string;
		danger?: boolean;
		/** When set, the dialog shows a text field with this placeholder. */
		placeholder?: string;
		/** A third button between cancel and confirm; only `askChoice` shows it. */
		alt?: string;
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

	/** True while a dialog is open (Messenger counts it as a navigation layer so Back closes it). */
	export const confirmOpen = (): boolean => pending !== null;
	/** Closes the open dialog as cancelled (system Back). */
	export function dismissConfirm(): void {
		pending?.resolve(false, '');
		pending = null;
	}

	/** Dialog with a second way out: resolves which button was pressed. */
	export function askChoice(options: AskOptions & { alt: string }): Promise<'confirm' | 'alt' | 'cancel'> {
		pending?.resolve(false, '');
		return new Promise((resolve) => {
			value = '';
			pending = { options, resolve: (ok, text) => resolve(ok ? (text === ALT ? 'alt' : 'confirm') : 'cancel') };
		});
	}
	const ALT = '\u0000alt';

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

	function pickAlt(): void {
		value = ALT;
		close(true);
	}

	$effect(() => {
		if (pending) {
			if (!opener && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
				opener = document.activeElement;
			}
			(field ?? (pending.options.danger ? cancelButton : confirmButton))?.focus();
		}
	});

	function onkeydown(event: KeyboardEvent): void {
		if (!pending) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			close(false);
		} else if (event.key === 'Enter' && !event.isComposing && !(event.target instanceof HTMLButtonElement)) {
			event.preventDefault();
			close(true);
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
		<div class="panel" class:danger={pending.options.danger} class:desktop={platform.target === 'desktop'} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
			<span class="grip"></span>
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
				{#if pending.options.alt}<button type="button" class="alt" onclick={pickAlt}>{pending.options.alt}</button>{/if}
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
		background: rgba(0, 0, 0, 0.5);
		animation: fade 0.15s ease-out;
	}
	.panel {
		display: grid;
		gap: 0.8rem;
		width: 100%;
		max-width: 28rem;
		min-width: min(25rem, 100%);
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
		color: var(--link);
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
	button.danger:hover,
	.panel.danger button.danger {
		background: var(--danger);
		color: var(--bg);
	}
	.grip {
		display: none;
	}
	.panel.desktop {
		gap: 0.6rem;
		max-width: 28rem;
		padding: 1rem;
		border-radius: var(--radius-lg);
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
		border-radius: var(--radius);
	}
	.panel.desktop input {
		height: 32px;
		padding: 0 0.65rem;
		border-radius: var(--radius);
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
	/* Touch: the same dialog as a bottom sheet (matches MessageSheet), full-width actions with the confirm on top. */
	@media (hover: none), (pointer: coarse) {
		.backdrop {
			place-items: end stretch;
			padding: 0;
		}
		.panel,
		.panel.desktop {
			gap: 0.7rem;
			max-width: none;
			min-width: 0;
			padding: 0.55rem 1.1rem calc(1rem + env(safe-area-inset-bottom));
			border-width: 0.5px 0 0;
			border-radius: 12px 12px 0 0;
			background: var(--panel);
			animation: rise 0.2s ease-out;
		}
		.grip {
			display: block;
			justify-self: center;
			width: 2rem;
			height: 4px;
			border-radius: 2px;
			background: var(--line-strong);
		}
		.panel h2,
		.panel.desktop h2 {
			font-size: 1.05rem;
		}
		.panel p,
		.panel.desktop p {
			font-size: 0.9rem;
		}
		.actions {
			flex-direction: column-reverse;
			margin-top: 0.3rem;
		}
		.panel button,
		.panel.desktop button {
			width: 100%;
			height: auto;
			min-height: 3rem;
			font-size: 0.95rem;
		}
		.panel input,
		.panel.desktop input {
			height: auto;
			font-size: 16px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.backdrop,
		.panel {
			animation: none !important;
		}
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
