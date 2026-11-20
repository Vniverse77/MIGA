<script lang="ts">
	import { BackupError, KIND_FILE, hexToBytesSafe, openRecoveryCode, parseHeader, parseRecoveryCode } from '../backup';
	import { decodeBackup, type BackupContent } from '../backup-data';
	import { sizeOf } from '../format';
	import { t, type MessageKey } from '../i18n.svelte';
	import type { Scanned } from '../qr';
	import Icon from './Icon.svelte';
	import PassphraseField from './PassphraseField.svelte';
	import Scanner from './Scanner.svelte';
	import Sheet from './Sheet.svelte';

	export type Restored = { secret: Uint8Array; content?: BackupContent };

	let {
		replacing,
		onrestore,
		onclose
	}: {
		/** This device already has an account: restoring replaces it. */
		replacing: boolean;
		onrestore: (restored: Restored) => Promise<void>;
		onclose: () => void;
	} = $props();

	type Source =
		| { kind: 'file'; name: string; size: number; bytes: Uint8Array }
		| { kind: 'code'; text: string }
		| { kind: 'raw'; secret: Uint8Array };
	/** Backups are small; this only stops a wrong, huge file from being read into memory. */
	const MAX_FILE = 128 * 1024 * 1024;

	let source = $state<Source | null>(null);
	let pass = $state('');
	let pasted = $state('');
	let busy = $state(false);
	let error = $state('');
	let wrong = $state(false);
	let dragging = $state(false);
	let scanning = $state(false);
	let input = $state<HTMLInputElement | null>(null);

	function setError(key: MessageKey): void {
		error = t(key);
	}

	async function takeFile(file: File | undefined): Promise<void> {
		if (!file) return;
		error = '';
		if (file.size > MAX_FILE) return setError('rs_bad_file');
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const header = parseHeader(bytes);
			if (header.kind !== KIND_FILE) return setError('rs_bad_file');
			source = { kind: 'file', name: file.name, size: file.size, bytes };
			wrong = false;
		} catch (e) {
			setError(e instanceof BackupError && e.code === 'version' ? 'rs_newer' : 'rs_bad_file');
		}
	}

	function onPaste(): void {
		error = '';
		const text = pasted.trim();
		if (!text) return;
		const raw = hexToBytesSafe(text);
		if (raw) {
			source = { kind: 'raw', secret: raw };
			pasted = '';
		} else if (parseRecoveryCode(text)) {
			source = { kind: 'code', text };
			pasted = '';
		} else if (text.length >= 40) {
			setError('rs_bad_code');
		}
	}

	function scanned(result: Scanned): void {
		scanning = false;
		if (result.kind === 'recovery') {
			source = { kind: 'code', text: result.code };
			error = '';
		}
	}

	function reset(): void {
		source = null;
		pass = '';
		error = '';
		wrong = false;
	}

	async function restore(): Promise<void> {
		if (!source || busy) return;
		if (source.kind !== 'raw' && !pass) return;
		busy = true;
		error = '';
		wrong = false;
		try {
			if (source.kind === 'file') {
				const content = await decodeBackup(source.bytes, pass);
				const secret = hexToBytesSafe(content.secret);
				if (!secret) throw new BackupError('format');
				await onrestore({ secret, content });
			} else if (source.kind === 'code') {
				await onrestore({ secret: await openRecoveryCode(source.text, pass) });
			} else {
				await onrestore({ secret: source.secret });
			}
			pass = '';
		} catch (e) {
			const code = e instanceof BackupError ? e.code : 'format';
			wrong = code === 'passphrase';
			setError(code === 'passphrase' ? 'rs_wrong' : code === 'version' ? 'rs_newer' : code === 'unsupported' ? 'rs_unsupported' : 'rs_bad_file');
		} finally {
			busy = false;
		}
	}

	function ondrop(event: DragEvent): void {
		event.preventDefault();
		dragging = false;
		if (!source) void takeFile(event.dataTransfer?.files?.[0]);
	}
</script>

<Sheet title={t('rs_title')} {onclose} {busy}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="body"
		class:dragging
		ondragover={(e) => (e.preventDefault(), !source && (dragging = true))}
		ondragleave={(e) => e.currentTarget === e.target && (dragging = false)}
		{ondrop}
	>
		{#if !source}
			<p class="lead">{t('rs_intro')}</p>
			<input bind:this={input} type="file" hidden onchange={(e) => (void takeFile(e.currentTarget.files?.[0]), (e.currentTarget.value = ''))} />
			<button type="button" class="drop" onclick={() => input?.click()}>
				<Icon name="upload" size={22} />
				<strong>{t('rs_file')}</strong>
				<small>{t('rs_drop')}</small>
			</button>
			<div class="or"><span>{t('rs_or')}</span></div>
			<label class="field">
				<span class="label">{t('rs_code')}</span>
				<textarea
					rows="3"
					bind:value={pasted}
					oninput={onPaste}
					placeholder="XXXXX-XXXXX-XXXXX-…"
					autocomplete="off"
					autocapitalize="characters"
					spellcheck="false"
				></textarea>
			</label>
			<button type="button" class="btn" onclick={() => (scanning = true)}><Icon name="scan" size={16} />{t('scan_button')}</button>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
		{:else}
			<div class="picked">
				<span class="glyph"><Icon name={source.kind === 'file' ? 'file' : source.kind === 'code' ? 'qr' : 'key'} size={20} /></span>
				<span class="what">
					<strong>{source.kind === 'file' ? source.name : source.kind === 'code' ? t('rs_found_code') : t('rs_found_raw')}</strong>
					<small>{source.kind === 'file' ? sizeOf(source.size) : source.kind === 'code' ? t('rs_found_code_sub') : t('rs_found_raw_sub')}</small>
				</span>
				<button type="button" class="btn change" disabled={busy} onclick={reset}>{t('rs_change')}</button>
			</div>
			{#if source.kind !== 'raw'}
				<PassphraseField bind:value={pass} label={t('rs_pass')} autofocus invalid={wrong} onenter={restore} />
			{/if}
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			{#if replacing}
				<div class="warn">
					<Icon name="alert" size={18} />
					<p>{t('rs_replace')}</p>
				</div>
			{/if}
			<div class="actions">
				<button type="button" class="btn" disabled={busy} onclick={onclose}>{t('cancel')}</button>
				<button type="button" class="btn primary" class:danger={replacing} disabled={busy || (source.kind !== 'raw' && !pass)} onclick={restore}>
					{busy ? t('rs_opening') : t('restore')}
				</button>
			</div>
		{/if}
	</div>
</Sheet>

{#if scanning}
	<Scanner accept="recovery" onresult={scanned} onclose={() => (scanning = false)} />
{/if}

<style>
	.body {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
		border-radius: var(--radius);
	}
	.drop {
		display: grid;
		justify-items: center;
		gap: 0.25rem;
		padding: 1.1rem 0.8rem;
		border: 1px dashed var(--line-strong);
		border-radius: var(--radius-lg);
		background: var(--bg);
		color: var(--accent-2);
		cursor: pointer;
		text-align: center;
	}
	.drop strong {
		color: var(--heading);
		font-size: 0.9rem;
		font-weight: 600;
	}
	.drop small {
		color: var(--muted);
		font-size: var(--fs-small);
	}
	.drop:hover,
	.dragging .drop {
		border-color: var(--accent-2);
		background: color-mix(in srgb, var(--accent) 10%, var(--bg));
	}
	.or {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		color: var(--muted);
		font-size: var(--fs-cap);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.or::before,
	.or::after {
		content: '';
		flex: 1;
		height: 0.5px;
		background: var(--line-strong);
	}
	.field {
		display: grid;
		gap: 0.3rem;
	}
	.label {
		color: var(--muted);
		font-size: var(--fs-small);
	}
	textarea {
		width: 100%;
		padding: 0.55rem 0.7rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-size: 0.8rem;
		line-height: 1.5;
		letter-spacing: 0.03em;
		resize: none;
		outline: none;
	}
	textarea:focus {
		border-color: var(--accent-2);
	}
	textarea::placeholder {
		color: var(--dim);
	}
	.picked {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 0.7rem;
		padding: 0.65rem 0.75rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius-lg);
		background: var(--bg);
	}
	.glyph {
		display: grid;
		place-items: center;
		width: 2.2rem;
		height: 2.2rem;
		border-radius: var(--radius);
		background: var(--panel-2);
		color: var(--accent-2);
	}
	.what {
		min-width: 0;
	}
	.what strong {
		display: block;
		overflow: hidden;
		color: var(--heading);
		font-size: 0.85rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.what small {
		color: var(--muted);
		font-size: var(--fs-small);
	}
	.change {
		min-height: 2rem;
		padding: 0 0.7rem;
	}
	@media (max-width: 760px), (pointer: coarse) {
		textarea {
			font-size: 16px;
		}
		.change {
			min-height: 2.5rem;
		}
	}
</style>
