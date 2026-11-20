<script lang="ts">
	import Logo from '../Logo.svelte';
	import LangSelect from '../LangSelect.svelte';
	import { getLanguage, t } from '../i18n.svelte';
	import { renderMarkdown } from './markdown';
	import privacyEn from '../../../../docs/legal/PRIVACY.md?raw';
	import privacyTr from '../../../../docs/legal/PRIVACY.tr.md?raw';
	import termsEn from '../../../../docs/legal/TERMS.md?raw';
	import termsTr from '../../../../docs/legal/TERMS.tr.md?raw';
	import kvkkEn from '../../../../docs/legal/KVKK.md?raw';
	import kvkkTr from '../../../../docs/legal/KVKK.tr.md?raw';

	let { doc }: { doc: 'privacy' | 'terms' | 'kvkk' } = $props();

	// Only English and Turkish texts exist; Turkmen and Russian readers get English.
	// The KVKK notice is binding in Turkish; a link switches between the Turkish text and the English summary.
	const texts = { privacy: [privacyEn, privacyTr], terms: [termsEn, termsTr], kvkk: [kvkkEn, kvkkTr] } as const;
	let swap = $state(false);
	const turkish = $derived((getLanguage() === 'tr') !== (doc === 'kvkk' && swap));
	const html = $derived(renderMarkdown(texts[doc][turkish ? 1 : 0]));
	const titles = { privacy: 'MIGA Privacy', terms: 'MIGA Terms', kvkk: 'MIGA KVKK' };
</script>

<svelte:head>
	<title>{titles[doc]}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<header class="top">
	<div class="wrap bar">
		<a class="brand" href="/"><Logo size={26} /><span>MIGA</span></a>
		<LangSelect />
	</div>
</header>

<main class="wrap doc">
	<nav class="tabs" aria-label="Legal">
		<a href="/privacy" aria-current={doc === 'privacy' ? 'page' : undefined}>{t('legal_privacy')}</a>
		<a href="/terms" aria-current={doc === 'terms' ? 'page' : undefined}>{t('legal_terms')}</a>
		<a href="/kvkk" aria-current={doc === 'kvkk' ? 'page' : undefined}>{t('legal_kvkk')}</a>
	</nav>
	{#if doc === 'kvkk'}
		<p class="alt">
			<button type="button" onclick={() => (swap = !swap)}>{turkish ? t('legal_en_summary') : t('legal_tr_full')}</button>
		</p>
	{/if}
	{@html html}
	<p class="back"><a href="/">&larr; {t('legal_back')}</a></p>
</main>

<style>
	.wrap {
		max-width: 46rem;
		margin: 0 auto;
		padding: 0 1rem;
	}
	.top {
		border-bottom: 0.5px solid var(--line);
		background: var(--panel);
	}
	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding-block: 0.7rem;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--heading);
		font-weight: 600;
		text-decoration: none;
	}
	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		border-bottom: 0.5px solid var(--line);
		margin-bottom: 2rem;
	}
	.tabs a {
		padding: 0.5rem 0.9rem;
		color: var(--dim);
		text-decoration: none;
		font-size: 0.9rem;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
	}
	.tabs a:hover {
		color: var(--link);
	}
	.tabs a[aria-current] {
		color: var(--heading);
		font-weight: 600;
		border-color: var(--link);
	}
	.alt {
		margin: 0 0 1rem;
		font-size: 0.85rem;
	}
	.alt button {
		background: none;
		border: 0;
		padding: 0;
		color: var(--link);
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
	}
	.doc :global(.date) {
		font-size: 0.8rem;
		color: var(--dim);
		margin: 0 0 1.5rem;
	}
	.doc :global(.short) {
		border: 0.5px solid var(--line);
		background: var(--panel);
		border-radius: var(--radius);
		padding: 0.9rem 1rem;
		margin-bottom: 1.5rem;
	}
	.doc :global(.short strong) {
		display: block;
		color: var(--heading);
		margin-bottom: 0.35rem;
	}
	.doc :global(.short p) {
		margin: 0;
	}
	.doc {
		padding-block: 2rem 4rem;
		line-height: 1.6;
		color: var(--text);
	}
	.doc :global(h1) {
		color: var(--heading);
		font-size: 2rem;
		line-height: 1.2;
		margin: 0 0 0.4rem;
	}
	.doc :global(h2) {
		color: var(--heading);
		font-size: 1.15rem;
		margin-top: 2rem;
	}
	.doc :global(a) {
		color: var(--link);
		overflow-wrap: anywhere;
	}
	.doc :global(code) {
		background: var(--panel-2);
		padding: 0.05rem 0.3rem;
		border-radius: var(--radius);
	}
	.doc :global(.tbl) {
		overflow-x: auto;
	}
	.doc :global(table) {
		border-collapse: collapse;
		font-size: 0.9rem;
		width: 100%;
	}
	.doc :global(th),
	.doc :global(td) {
		border: 0.5px solid var(--line);
		padding: 0.45rem 0.6rem;
		text-align: left;
		vertical-align: top;
	}
	.doc :global(th) {
		background: var(--panel);
		color: var(--heading);
	}
	.back {
		margin-top: 3rem;
	}
</style>
