<script lang="ts">
	import { t, type MessageKey } from '../i18n.svelte';
	import { passphraseScore } from '../backup';
	import Icon from './Icon.svelte';

	let {
		value = $bindable(''),
		label,
		creating = false,
		autofocus = false,
		invalid = false,
		onenter
	}: {
		value: string;
		label: string;
		/** A new passphrase: show the strength bar. */
		creating?: boolean;
		autofocus?: boolean;
		invalid?: boolean;
		onenter?: () => void;
	} = $props();

	let shown = $state(false);
	const score = $derived(passphraseScore(value));
	const words: MessageKey[] = ['bk_pw_short', 'bk_pw_ok', 'bk_pw_good', 'bk_pw_strong'];
</script>

<label class="field">
	<span class="label">{label}</span>
	<span class="box" class:invalid>
		<input
			bind:value
			type={shown ? 'text' : 'password'}
			autocomplete={creating ? 'new-password' : 'current-password'}
			autocapitalize="off"
			autocorrect="off"
			spellcheck="false"
			data-autofocus={autofocus ? '' : undefined}
			aria-invalid={invalid}
			onkeydown={(e) => e.key === 'Enter' && !e.isComposing && onenter && (e.preventDefault(), onenter())}
		/>
		<button type="button" class="eye" aria-label={t(shown ? 'bk_pw_hide' : 'bk_pw_show')} title={t(shown ? 'bk_pw_hide' : 'bk_pw_show')} aria-pressed={shown} onclick={() => (shown = !shown)}>
			<Icon name={shown ? 'eye-off' : 'eye'} size={18} />
		</button>
	</span>
	{#if creating && value}
		<span class="meter" data-score={score} aria-live="polite">
			<span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>
			<span class="word">{t(words[score])}</span>
		</span>
	{/if}
</label>

<style>
	.field {
		display: grid;
		gap: 0.3rem;
		min-width: 0;
	}
	.label {
		color: var(--muted);
		font-size: var(--fs-small);
	}
	.box {
		display: flex;
		align-items: center;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
	}
	.box:focus-within {
		border-color: var(--accent-2);
	}
	.box.invalid {
		border-color: var(--danger);
	}
	input {
		flex: 1;
		min-width: 0;
		height: 2.5rem;
		padding: 0 0.7rem;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 0.9rem;
		outline: none;
	}
	.eye {
		display: grid;
		place-items: center;
		flex: none;
		width: 2.5rem;
		height: 2.5rem;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}
	.eye:hover {
		color: var(--text);
	}
	.meter {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--muted);
		font-size: var(--fs-cap);
	}
	.bars {
		display: flex;
		gap: 3px;
	}
	.bars i {
		width: 1.4rem;
		height: 3px;
		border-radius: 2px;
		background: var(--line-strong);
	}
	.meter[data-score='0'] .bars i:nth-child(1) {
		background: var(--danger);
	}
	.meter[data-score='1'] .bars i:nth-child(-n + 1),
	.meter[data-score='2'] .bars i:nth-child(-n + 2),
	.meter[data-score='3'] .bars i:nth-child(-n + 3) {
		background: var(--accent-2);
	}
	@media (max-width: 760px), (pointer: coarse) {
		input {
			height: 3rem;
			font-size: 16px;
		}
		.eye {
			width: 3rem;
			height: 3rem;
		}
	}
</style>
