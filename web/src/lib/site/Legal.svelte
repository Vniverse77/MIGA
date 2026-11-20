<script lang="ts">
	import Logo from '../Logo.svelte';
	import LangSelect from '../LangSelect.svelte';
	import { getLanguage, t } from '../i18n.svelte';
	import { renderMarkdown } from './markdown';
	import privacyEn from '../../../../docs/legal/PRIVACY.md?raw';
	import privacyTr from '../../../../docs/legal/PRIVACY.tr.md?raw';
	import termsEn from '../../../../docs/legal/TERMS.md?raw';
	import termsTr from '../../../../docs/legal/TERMS.tr.md?raw';

	let { doc }: { doc: 'privacy' | 'terms' } = $props();

	// Only English and Turkish texts exist; Turkmen and Russian readers get English.
	const html = $derived(
		renderMarkdown(
			doc === 'privacy' ? (getLanguage() === 'tr' ? privacyTr : privacyEn) : getLanguage() === 'tr' ? termsTr : termsEn
		)
	);
</script>

<svelte:head>
	<title>{doc === 'privacy' ? 'MIGA Privacy' : 'MIGA Terms'}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<header class="top">
	<div class="wrap bar">
		<a class="brand" href="/"><Logo size={26} /><span>MIGA</span></a>
		<nav>
			<a href="/privacy" aria-current={doc === 'privacy' ? 'page' : undefined}>{t('legal_privacy')}</a>
			<a href="/terms" aria-current={doc === 'terms' ? 'page' : undefined}>{t('legal_terms')}</a>
			<LangSelect />
		</nav>
	</div>
</header>

<main class="wrap doc">
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
	nav {
		display: flex;
		align-items: center;
		gap: 1rem;
	}
	nav a {
		color: var(--dim);
		text-decoration: none;
		font-size: 0.9rem;
	}
	nav a:hover,
	nav a[aria-current] {
		color: var(--link);
	}
	.doc {
		padding-block: 2rem 4rem;
		line-height: 1.6;
		color: var(--text);
	}
	.doc :global(h1) {
		color: var(--heading);
		font-size: 1.6rem;
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
