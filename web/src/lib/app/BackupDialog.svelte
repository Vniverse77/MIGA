<script lang="ts">
	import { MIN_PASSPHRASE, recoveryCode } from '../backup';
	import { backupFileName, buildBackup, encodeBackup, type Snapshot } from '../backup-data';
	import type { Identity } from '../crypto';
	import { t } from '../i18n.svelte';
	import { platform } from '../platform';
	import { dateOf } from '../format';
	import type { BackupInfo } from '../storage';
	import Icon from './Icon.svelte';
	import PassphraseField from './PassphraseField.svelte';
	import QrCode from './QrCode.svelte';
	import Sheet from './Sheet.svelte';

	let {
		identity,
		snapshot,
		last,
		onsaved,
		onclose
	}: {
		identity: Identity;
		snapshot: () => Snapshot;
		last: BackupInfo | null;
		onsaved: (kind: 'file' | 'code') => void;
		onclose: () => void;
	} = $props();

	let step = $state<'choose' | 'file' | 'code' | 'fileDone' | 'codeShow'>('choose');
	let extras = $state(true);
	let history = $state(false);
	let pass = $state('');
	let pass2 = $state('');
	let busy = $state(false);
	let error = $state('');
	let code = $state<{ compact: string; grouped: string } | null>(null);
	let copied = $state(false);

	const long = $derived([...pass.normalize('NFKC')].length >= MIN_PASSPHRASE);
	const mismatch = $derived(pass2.length > 0 && pass !== pass2);
	const ready = $derived(long && pass === pass2 && !busy);
	const titles = {
		choose: 'bk_title',
		file: 'bk_file',
		code: 'bk_code',
		fileDone: 'bk_saved_title',
		codeShow: 'bk_code'
	} as const;

	function pick(next: 'file' | 'code'): void {
		step = next;
		error = '';
		pass = pass2 = '';
	}

	async function saveFile(): Promise<void> {
		if (!ready) return;
		busy = true;
		error = '';
		try {
			const content = buildBackup(identity, snapshot(), { extras, history });
			const bytes = await encodeBackup(content, pass);
			const result = await platform.saveFile(backupFileName(), bytes, 'application/octet-stream');
			if (result === 'saved') {
				onsaved('file');
				pass = pass2 = '';
				step = 'fileDone';
			}
		} catch {
			error = t('bk_failed');
		} finally {
			busy = false;
		}
	}

	async function makeCode(): Promise<void> {
		if (!ready) return;
		busy = true;
		error = '';
		try {
			code = await recoveryCode(identity.secret, pass);
			pass = pass2 = '';
			step = 'codeShow';
		} catch {
			error = t('bk_failed');
		} finally {
			busy = false;
		}
	}

	async function copyCode(): Promise<void> {
		if (!code) return;
		try {
			await navigator.clipboard.writeText(code.grouped);
			copied = true;
		} catch {
			copied = false;
		}
	}

	function finishCode(): void {
		onsaved('code');
		code = null;
		onclose();
	}
</script>

<Sheet title={t(titles[step])} {onclose} {busy}>
	{#if step === 'choose'}
		<p class="lead">{t('bk_intro')}</p>
		<button type="button" class="opt" onclick={() => pick('file')}>
			<span class="glyph"><Icon name="file" size={20} /></span>
			<span><strong>{t('bk_file')}</strong><small>{t('bk_file_sub')}</small></span>
			<Icon name="chevron-right" size={18} />
		</button>
		<button type="button" class="opt" onclick={() => pick('code')}>
			<span class="glyph"><Icon name="qr" size={20} /></span>
			<span><strong>{t('bk_code')}</strong><small>{t('bk_code_sub')}</small></span>
			<Icon name="chevron-right" size={18} />
		</button>
		<p class="hint">{last ? t('bk_last', { when: dateOf(last.ts) }) : t('bk_never')}</p>
	{:else if step === 'file'}
		<label class="check">
			<input type="checkbox" bind:checked={extras} />
			<span>{t('bk_extras')}<small>{t('bk_extras_sub')}</small></span>
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={history} />
			<span>{t('bk_history')}<small>{t('bk_history_sub')}</small></span>
		</label>
		{@render passFields()}
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<div class="actions">
			<button type="button" class="btn" disabled={busy} onclick={() => (step = 'choose')}>{t('back')}</button>
			<button type="button" class="btn primary" disabled={!ready} onclick={saveFile}>
				{busy ? t('bk_encrypting') : t('bk_save')}
			</button>
		</div>
	{:else if step === 'code'}
		<p class="lead">{t('bk_code_intro')}</p>
		{@render passFields()}
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		<div class="actions">
			<button type="button" class="btn" disabled={busy} onclick={() => (step = 'choose')}>{t('back')}</button>
			<button type="button" class="btn primary" disabled={!ready} onclick={makeCode}>
				{busy ? t('bk_encrypting') : t('bk_make_code')}
			</button>
		</div>
	{:else if step === 'fileDone'}
		<div class="done">
			<span class="badge"><Icon name="check" size={24} /></span>
			<p class="lead">{t('bk_saved_text')}</p>
		</div>
		<div class="actions"><button type="button" class="btn primary" onclick={onclose}>{t('bk_done')}</button></div>
	{:else if code}
		<div class="warn">
			<Icon name="alert" size={18} />
			<p>{t('bk_code_warn')}</p>
		</div>
		<QrCode text={code.compact} label={t('bk_code')} />
		<p class="grouped selectable" aria-label={t('bk_code')}>{code.grouped}</p>
		<p class="hint">{t('bk_code_pass_note')}</p>
		<div class="actions">
			<button type="button" class="btn" onclick={copyCode}><Icon name="copy" size={16} />{copied ? t('bk_code_copied') : t('bk_copy_code')}</button>
			<button type="button" class="btn primary" onclick={finishCode}>{t('bk_code_done')}</button>
		</div>
	{/if}
</Sheet>

{#snippet passFields()}
	<PassphraseField bind:value={pass} label={t('bk_pass')} creating autofocus />
	<PassphraseField bind:value={pass2} label={t('bk_pass2')} invalid={mismatch} onenter={step === 'file' ? saveFile : makeCode} />
	{#if mismatch}
		<p class="error" role="alert">{t('bk_mismatch')}</p>
	{:else}
		<p class="hint">{t('bk_pass_hint')}</p>
	{/if}
{/snippet}

<style>
	.grouped {
		margin: 0;
		padding: 0.6rem 0.7rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--heading);
		font-size: 0.78rem;
		line-height: 1.7;
		letter-spacing: 0.04em;
		overflow-wrap: anywhere;
		text-align: center;
		user-select: text;
	}
</style>
