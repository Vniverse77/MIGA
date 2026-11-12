<script lang="ts">
	import { VERSION_LABEL, VERSION_TITLE } from '../version';
	import logo from '#lib/assets/favicon.svg';
	import LangSelect from '../LangSelect.svelte';
	import { t } from '../i18n.svelte';
</script>

<svelte:head>
	<title>MIGA — Make Internet Great Again</title>
	<meta
		name="description"
		content="MIGA is an experimental end-to-end encrypted messenger by Vniverse77, built to keep people connected across restricted networks."
	/>
</svelte:head>

<header class="top">
	<div class="wrap bar">
		<a class="brand" href="/">
			<img src={logo} alt="" width="30" height="30" />
			<span>MIGA</span>
			<span class="ver" title={VERSION_TITLE}>{VERSION_LABEL}</span>
		</a>
		<nav aria-label="Main">
			<a class="link" href="https://vniverse77.com/">Vniverse77</a>
			<a class="link" href="https://forum.vniverse77.com/">Forum</a>
			<a class="link" href="https://github.com/Vniverse77/MIGA">{t('nav_source')}</a>
			<LangSelect />
			<a class="btn primary small" href="/app/">{t('nav_app')}</a>
		</nav>
	</div>
</header>

<main>
	<section class="hero wrap">
		<div class="pitch">
			<p class="badge">{t('badge')}</p>
			<h1>MIGA</h1>
			<p class="sub">Make Internet Great Again</p>
			<p class="lead">
				{t('lead')}
			</p>
			<div class="cta">
				<a class="btn primary" href="/app/">{t('cta_open')}</a>
				<a class="btn outline" href="https://github.com/Vniverse77/MIGA">{t('cta_code')}</a>
			</div>
		</div>

		<div class="card flow" aria-label="How a message travels">
			<p class="flow-title">$ miga send</p>
			<ol>
				<li><span>01</span>{t('flow_1')}</li>
				<li><span>02</span>{t('flow_2')}</li>
				<li><span>03</span>{t('flow_3')}</li>
			</ol>
			<p class="flow-note">{t('flow_note')}</p>
		</div>
	</section>

	<section class="wrap">
		<h2>{t('how_title')}</h2>
		<p class="section-lead">{t('how_lead')}</p>
		<div class="grid">
			<article class="card">
				<h3>{t('f1_title')}</h3>
				<p>{t('f1_text')}</p>
			</article>
			<article class="card">
				<h3>{t('f2_title')}</h3>
				<p>{t('f2_text')}</p>
			</article>
			<article class="card">
				<h3>{t('f3_title')}</h3>
				<p>{t('f3_text')}</p>
			</article>
		</div>
	</section>

	<section class="wrap">
		<h2>{t('part_title')}</h2>
		<p class="section-lead">{t('part_lead')}</p>
		<div class="grid two">
			<a class="card linkcard" href="https://forum.vniverse77.com/">
				<h3>Forum</h3>
				<p>{t('forum_text')}</p>
			</a>
			<a class="card linkcard" href="https://vniverse77.com/">
				<h3>vniverse77.com</h3>
				<p>{t('site_text')}</p>
			</a>
		</div>
	</section>
</main>

<footer>
	<div class="wrap foot">
		<p class="warning">
			{t('warning')}
		</p>
		<nav aria-label="Footer">
			<a href="https://vniverse77.com/">Vniverse77</a>
			<a href="https://forum.vniverse77.com/">Forum</a>
			<a href="https://github.com/Vniverse77/MIGA">GitHub</a>
		</nav>
	</div>
</footer>

<style>
	.wrap {
		width: 100%;
		max-width: 68rem;
		margin: 0 auto;
		padding: 0 1.5rem;
	}

	/* Header */
	.top {
		position: sticky;
		top: 0;
		z-index: 10;
		border-bottom: 0.5px solid var(--line);
		background: color-mix(in srgb, var(--bg) 92%, transparent);
	}
	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		min-height: 3.5rem;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		color: var(--heading);
		font-weight: 700;
		letter-spacing: 0.14em;
		text-decoration: none;
	}
	.ver {
		font-size: 0.68rem;
		font-weight: 500;
		letter-spacing: 0.04em;
		color: var(--muted);
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		padding: 0.05rem 0.4rem;
	}
	.brand img {
		display: block;
	}
	nav {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 1.25rem;
	}
	.link {
		color: var(--dim);
		font-size: 0.9rem;
		text-decoration: none;
		transition: color 0.15s ease;
	}
	.link:hover {
		color: var(--accent-2);
	}

	/* Buttons */
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.75rem 1.5rem;
		border: 0.5px solid var(--accent);
		border-radius: var(--radius);
		font-weight: 500;
		text-decoration: none;
		white-space: nowrap;
		transition:
			background-color 0.2s ease,
			color 0.2s ease;
	}
	.btn.small {
		padding: 0.4rem 0.9rem;
		font-size: 0.9rem;
		font-weight: 700;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--accent-ink);
	}
	.btn.primary:hover {
		background: var(--accent-2);
	}
	.btn.outline {
		color: var(--accent-2);
	}
	.btn.outline:hover {
		background: var(--accent);
		color: var(--accent-ink);
	}

	/* Hero */
	.hero {
		display: grid;
		grid-template-columns: 1.1fr 0.9fr;
		align-items: center;
		gap: 3rem;
		min-height: calc(100dvh - 3.5rem);
		padding-top: 3rem;
		padding-bottom: 3rem;
	}
	.badge {
		margin: 0 0 1rem;
		color: var(--accent-2);
		font-size: 0.875rem;
		letter-spacing: 0.02em;
	}
	h1 {
		margin: 0 0 0.75rem;
		color: var(--heading);
		font-size: clamp(2.6rem, 9vw, 4.5rem);
		font-weight: 700;
		letter-spacing: 0.06em;
		line-height: 1;
	}
	.sub {
		margin: 0 0 1.5rem;
		color: var(--text);
		font-size: clamp(1.15rem, 3vw, 1.75rem);
		font-weight: 600;
	}
	.lead {
		margin: 0 0 2rem;
		max-width: 32rem;
		color: var(--muted);
	}
	.cta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	/* Cards */
	.card {
		padding: 1.25rem;
		border: 0.5px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--panel);
	}
	.flow-title {
		margin: 0 0 1rem;
		color: var(--dim);
		font-size: 0.85rem;
	}
	.flow ol {
		display: grid;
		gap: 0.9rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.flow li {
		display: grid;
		grid-template-columns: 2rem 1fr;
		color: var(--text);
		font-size: 0.92rem;
	}
	.flow li span {
		color: var(--accent-2);
	}
	.flow-note {
		margin: 1.1rem 0 0;
		padding-top: 0.9rem;
		border-top: 0.5px solid var(--line);
		color: var(--muted);
		font-size: 0.85rem;
	}

	/* Sections */
	section:not(.hero) {
		padding-top: 4rem;
		padding-bottom: 1rem;
	}
	h2 {
		margin: 0 0 0.4rem;
		color: var(--heading);
		font-size: clamp(1.5rem, 4vw, 2.1rem);
	}
	.section-lead {
		margin: 0 0 1.75rem;
		color: var(--muted);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 1rem;
	}
	.grid.two {
		grid-template-columns: repeat(2, 1fr);
	}
	h3 {
		margin: 0 0 0.5rem;
		color: var(--heading);
		font-size: 1rem;
	}
	.card p {
		margin: 0;
		color: var(--muted);
		font-size: 0.9rem;
	}
	.linkcard {
		display: block;
		text-decoration: none;
		transition: border-color 0.2s ease;
	}
	.linkcard:hover {
		border-color: var(--line-strong);
	}
	.linkcard h3::after {
		content: ' →';
		color: var(--accent-2);
	}

	/* Footer */
	footer {
		margin-top: 5rem;
		padding: 2.5rem 0;
		border-top: 0.5px solid var(--line);
		background: var(--panel);
	}
	.foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 1.25rem;
	}
	.warning {
		margin: 0;
		max-width: 38rem;
		color: var(--muted);
		font-size: 0.85rem;
	}
	footer a {
		color: var(--dim);
		font-size: 0.9rem;
		text-decoration: none;
	}
	footer a:hover {
		color: var(--accent-2);
	}

	@media (max-width: 820px) {
		.hero {
			grid-template-columns: 1fr;
			gap: 2rem;
			min-height: 0;
		}
		.grid,
		.grid.two {
			grid-template-columns: 1fr;
		}
		.link {
			display: none;
		}
		.wrap {
			padding: 0 1rem;
		}
		.bar {
			gap: 0.5rem;
		}
		nav {
			flex-wrap: nowrap;
			gap: 0.5rem;
			min-width: 0;
		}
		.btn.small {
			padding: 0.4rem 0.7rem;
		}
	}
</style>
