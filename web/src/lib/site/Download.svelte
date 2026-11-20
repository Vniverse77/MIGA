<script lang="ts">
	import { onMount } from 'svelte';
	import SiteHeader from './SiteHeader.svelte';
	import { t } from '../i18n.svelte';
	import { RELEASE_DATE, RELEASE_VERSION, URLS, YAY, FLATPAK_CMD } from './release';

	type Os = 'linux' | 'android' | 'web' | 'windows';
	let channel = $state<'stable' | 'beta'>('stable');
	let detected = $state<Os | ''>('');
	let copied = $state('');

	// The visitor's platform, from the user agent. Only used to order the rows and pick the tab; nothing is sent.
	onMount(() => {
		const ua = navigator.userAgent;
		if (/android/i.test(ua)) {
			detected = 'android';
			channel = 'beta';
		} else if (/linux|x11|cros/i.test(ua)) detected = 'linux';
		else if (/windows/i.test(ua)) detected = 'windows';
	});

	// Stable lists the finished builds, Beta the ones still being tested.
	const stable: Os[] = ['linux', 'web', 'windows'];
	let rows = $derived(
		detected && stable.includes(detected)
			? [detected, ...stable.filter((o) => o !== detected)]
			: stable
	);

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = text;
			setTimeout(() => (copied = ''), 1800);
		} catch {
			/* clipboard blocked: the command stays selectable */
		}
	}
	// TODO: when the legal pages (/terms) are live on master, add the line
	// "By downloading and using MIGA you agree to its terms" with a link below the card.
</script>

<svelte:head>
	<title>{t('dp_title')} · MIGA</title>
	<meta name="description" content="Download MIGA for Android, Linux and the web." />
</svelte:head>

<SiteHeader current="download" />

<main class="wrap">
	<section class="head">
		<img class="icon" src="/android-chrome-512x512.png" alt="" width="128" height="128" />
		<div class="info">
			<p class="name">MIGA</p>
			<h1>{RELEASE_VERSION}</h1>
			<p class="meta">
				<span>{t('dp_released', { date: RELEASE_DATE })}</span>
				<a href={URLS.changelog}>{t('dp_changelog')} →</a>
			</p>
		</div>
	</section>

	<div class="tabs" role="tablist" aria-label="Channel">
		<button
			type="button"
			role="tab"
			aria-selected={channel === 'stable'}
			class:on={channel === 'stable'}
			onclick={() => (channel = 'stable')}>{t('dp_stable')}</button
		>
		<button
			type="button"
			role="tab"
			aria-selected={channel === 'beta'}
			class:on={channel === 'beta'}
			onclick={() => (channel = 'beta')}>{t('dp_beta')}</button
		>
	</div>
	<p class="chan-note">{channel === 'stable' ? t('dp_stable_note') : t('dp_beta_note')}</p>

	<div class="list" role="tabpanel">
		{#if channel === 'beta'}
			<article class="row" class:you={detected === 'android'}>
				<header>
					<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></svg>
					<h2>Android</h2>
					{#if detected === 'android'}<span class="you-tag">{t('dp_your_device')}</span>{/if}
					<span class="arch">APK</span>
				</header>
				<a class="btn primary" href={URLS.apk} download>{t('dl_android_btn')}</a>
				<p class="note">{t('dp_android_hint')}</p>
				<a class="txt" href={URLS.sha}>{t('dp_sha')} →</a>
			</article>
		{:else}
			{#each rows as os (os)}
				{#if os === 'linux'}
					<article class="row" class:you={detected === 'linux'}>
						<header>
							<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="m7.5 9.5 3 2.5-3 2.5M13 15h4" /></svg>
							<h2>{t('dp_linux')}</h2>
							{#if detected === 'linux'}<span class="you-tag">{t('dp_your_device')}</span>{/if}
							<span class="arch" title={t('dp_arch')}>x86_64</span>
						</header>
						<a class="btn primary" href={URLS.deb}>{t('dp_download_now')} <span class="ext">.deb</span></a>
						<p class="note">{t('dp_deb_hint')}</p>
						<div class="sub">
							<a class="btn outline" href={URLS.flatpak}>{t('dp_flatpak')}</a>
							<p class="note">{t('dp_flatpak_hint')}</p>
							<div class="cmd">
								<code>{FLATPAK_CMD}</code>
								<button type="button" class="copy" onclick={() => copy(FLATPAK_CMD)}>
									{copied === FLATPAK_CMD ? t('dl_copied') : t('dl_copy')}
								</button>
							</div>
						</div>
						<div class="sub">
							<p class="label">{t('dp_aur')}</p>
							<div class="cmd">
								<code>{YAY}</code>
								<button type="button" class="copy" onclick={() => copy(YAY)}>
									{copied === YAY ? t('dl_copied') : t('dl_copy')}
								</button>
							</div>
							<a class="txt" href={URLS.aur}>{t('dl_aur_link')} →</a>
						</div>
					</article>
				{:else if os === 'web'}
					<article class="row">
						<header>
							<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z" /></svg>
							<h2>{t('dp_web')}</h2>
						</header>
						<a class="btn primary" href="/app/">{t('dl_web_btn')}</a>
						<p class="note">{t('dp_web_hint')}</p>
					</article>
				{:else}
					<article class="row off">
						<header>
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.5 10.5 4.5v7H3zM12 4.3 21 3v8.5h-9zM3 13h7.5v7L3 18.8zM12 13h9v8l-9-1.3z" /></svg>
							<h2>Windows</h2>
							<span class="arch">{t('dl_soon')}</span>
						</header>
						<span class="btn disabled" aria-disabled="true">{t('dl_soon')}</span>
					</article>
				{/if}
			{/each}
		{/if}
	</div>

	<p class="other"><a href={URLS.releases}>{t('dp_all')} →</a></p>
</main>

<style>
	.wrap {
		width: 100%;
		max-width: 46rem;
		margin: 0 auto;
		padding: 0 1.5rem 4rem;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 2rem;
		padding: 3.5rem 0 2.5rem;
	}
	.icon {
		flex: none;
		width: 8rem;
		height: 8rem;
		border-radius: 1.75rem;
		border: 0.5px solid var(--line-strong);
		background: var(--panel);
	}
	.name {
		margin: 0;
		color: var(--muted);
		font-size: 0.85rem;
		letter-spacing: 0.14em;
	}
	h1 {
		margin: 0.1rem 0 0.4rem;
		color: var(--heading);
		font-size: clamp(2.6rem, 9vw, 4rem);
		font-weight: 700;
		letter-spacing: 0.02em;
		line-height: 1.05;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 1.25rem;
		margin: 0;
		color: var(--muted);
		font-size: 0.85rem;
	}
	.meta a,
	.txt,
	.other a {
		color: var(--link);
		text-decoration: none;
	}
	.meta a:hover,
	.txt:hover,
	.other a:hover {
		text-decoration: underline;
	}

	/* Channel tabs */
	.tabs {
		display: flex;
		gap: 1.75rem;
		border-bottom: 0.5px solid var(--line);
	}
	.tabs button {
		margin-bottom: -0.5px;
		padding: 0.6rem 0;
		min-height: 2.75rem;
		border: 0;
		border-bottom: 1.5px solid transparent;
		background: none;
		color: var(--muted);
		font-size: 0.95rem;
		cursor: pointer;
		transition: color 0.15s ease;
	}
	.tabs button:hover {
		color: var(--text);
	}
	.tabs button.on {
		border-bottom-color: var(--accent-2);
		color: var(--heading);
	}
	.chan-note {
		margin: 0.9rem 0 1.25rem;
		color: var(--muted);
		font-size: 0.85rem;
	}

	/* Platform rows */
	.list {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.75rem;
	}
	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.8rem;
		padding: 1.25rem;
		border: 0.5px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--panel);
	}
	.row.you {
		border-color: var(--line-strong);
	}
	.row header {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		margin-bottom: 0.3rem;
	}
	.row svg {
		flex: none;
		width: 1.35rem;
		height: 1.35rem;
		fill: none;
		stroke: var(--link);
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.row.off svg {
		stroke: var(--muted);
	}
	h2 {
		margin: 0;
		color: var(--heading);
		font-size: 1rem;
	}
	.you-tag {
		color: var(--link);
		font-size: 0.72rem;
		letter-spacing: 0.02em;
	}
	.arch {
		margin-left: auto;
		padding: 0.15rem 0.6rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		color: var(--muted);
		font-size: 0.75rem;
	}
	.note {
		margin: -0.2rem 0 0;
		color: var(--muted);
		font-size: 0.8rem;
	}
	.label {
		margin: 0;
		color: var(--text);
		font-size: 0.85rem;
	}
	.sub {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.6rem;
		margin-top: 0.6rem;
		padding-top: 1rem;
		border-top: 0.5px solid var(--line);
	}
	.sub .note {
		margin: 0;
	}
	.btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.6rem;
		width: 100%;
		min-height: 2.9rem;
		padding: 0.6rem 1.25rem;
		border: 0.5px solid var(--accent);
		border-radius: var(--radius);
		font-weight: 500;
		text-decoration: none;
		transition:
			background-color 0.2s ease,
			color 0.2s ease;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--accent-ink);
	}
	.btn.primary:hover {
		background: var(--accent-2);
	}
	.btn.outline {
		color: var(--link);
	}
	.btn.outline:hover {
		background: var(--accent);
		color: var(--accent-ink);
	}
	.btn.disabled {
		border-color: var(--line-strong);
		color: var(--muted);
		cursor: not-allowed;
	}
	.ext {
		opacity: 0.75;
		font-size: 0.85em;
	}
	.cmd {
		display: flex;
		align-items: center;
		width: 100%;
		padding-left: 0.75rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
	}
	.cmd code {
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		white-space: nowrap;
		color: var(--text);
		font-size: 0.85rem;
	}
	.copy {
		min-width: 5.5rem;
		min-height: 2.75rem;
		padding: 0 0.8rem;
		border: 0;
		border-left: 0.5px solid var(--line-strong);
		border-radius: 0 var(--radius) var(--radius) 0;
		background: transparent;
		color: var(--link);
		font-size: 0.85rem;
		cursor: pointer;
	}
	.copy:hover {
		background: var(--accent);
		color: var(--accent-ink);
	}
	.txt {
		display: inline-flex;
		align-items: center;
		min-height: 2.5rem;
		font-size: 0.85rem;
	}
	.other {
		margin: 1.5rem 0 0;
		font-size: 0.85rem;
	}

	@media (max-width: 820px) {
		.wrap {
			padding: 0 1rem 3rem;
		}
	}
	@media (max-width: 520px) {
		.head {
			gap: 1.1rem;
			padding: 1.75rem 0 1.5rem;
		}
		.icon {
			width: 5rem;
			height: 5rem;
			border-radius: 1.1rem;
		}
		.row {
			padding: 1rem;
		}
	}
</style>
