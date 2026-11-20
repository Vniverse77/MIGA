<script lang="ts">
	import { onMount } from 'svelte';
	import { VERSION_LABEL } from '../version';
	import SiteHeader from './SiteHeader.svelte';
	import CopyButton from './CopyButton.svelte';
	import { t } from '../i18n.svelte';
	import { RELEASE_VERSION, URLS, YAY, FLATPAK_CMD } from './release';
	import type { MessageKey } from '../i18n.svelte';
	import type { SceneHandle } from './landing-scene';

	type Os = 'android' | 'linux' | 'web' | 'windows';

	// TODO: when a walkthrough video exists, put its self-hosted file in web/static/landing/ and set these.
	// The section stays hidden while VIDEO_SRC is empty. No YouTube embed: nothing third-party loads here.
	const VIDEO_SRC = '';
	const VIDEO_POSTER = '';

	let canvas: HTMLCanvasElement | undefined = $state();
	let glReady = $state(false);
	let armed = $state(false);
	let os = $state<Os>('linux');
	let activeStep = $state(0);
	let howStep = $state(0);

	const file = (url: string) => url.split('/').pop() ?? '';
	const DEB_CMD = `sudo apt install ./${file(URLS.deb)}`;
	const FLATPAK_RUN = 'flatpak run com.vniverse77.miga';
	const SHA_APK = `sha256sum ${file(URLS.apk)}`;
	const SHA_LINUX = 'sha256sum -c --ignore-missing sha256sums.txt';

	// "Title|Body" strings from the dictionary.
	const pair = (key: MessageKey): [string, string] => {
		const s = t(key);
		const i = s.indexOf('|');
		return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
	};
	const list = (prefix: string, n: number) =>
		Array.from({ length: n }, (_, i) => pair(`${prefix}${i + 1}` as MessageKey));

	let why = $derived(list('lp_why', 4));
	let androidSteps = $derived(list('lp_a', 5));
	let webSteps = $derived(list('lp_w', 3));
	let startSteps = $derived(list('lp_s', 6));
	let features = $derived(list('lp_ft', 12));
	let howSteps = $derived(list('lp_hs', 4));
	let faq = $derived(list('lp_q', 10));

	const featureIcons = [
		'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6zM12 15v2',
		'M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 20c0-3.6 3.1-6 7-6s7 2.4 7 6',
		'M5 4h5v5H5zM14 4h5v5h-5zM5 13h5v5H5zM14 13h2v2h-2zM18 13h1v5h-5v-1',
		'M4 6h11v8H4zM9 18h2M17 9h3v10h-6v-3M3 20h8',
		'M12 4v11M8 11l4 4 4-4M5 20h14',
		'M4 6h16v12H4zM4 7l8 6 8-6',
		'M4 5h16v14H4zM8 10a1.5 1.5 0 1 0 0-.01M4 16l5-5 4 4 3-3 4 4',
		'M9 14 4 9l5-5M4 9h9a6 6 0 0 1 6 6v2',
		'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l4 4',
		'M4 6h10M4 12h16M4 18h7M17 4v4',
		'M4 12l5 5L20 6',
		'M12 21a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3zM6 17V11a6 6 0 0 1 12 0v6z'
	];

	const phoneShots = ['list', 'address', 'address', 'chat', 'chat', 'requests'];
	const shotAlt = $derived(t('lp_shot_alt'));

	onMount(() => {
		const ua = navigator.userAgent;
		if (/android/i.test(ua)) os = 'android';
		else if (/linux|x11|cros/i.test(ua) && !/android/i.test(ua)) os = 'linux';
		else os = 'web';

		const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
		const saver = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
		const cleanups: (() => void)[] = [];

		// Entrance animations: sections slide and fade in once. Without JS or with reduced motion they are simply visible.
		if (!reduced && 'IntersectionObserver' in window) {
			armed = true;
			const io = new IntersectionObserver(
				(entries) => {
					for (const e of entries) {
						if (e.isIntersecting) {
							e.target.classList.add('in');
							io.unobserve(e.target);
						}
					}
				},
				{ rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
			);
			document.querySelectorAll('[data-reveal]').forEach((el) => io.observe(el));
			cleanups.push(() => io.disconnect());
		}

		// Which "getting started" step is in view drives the phone picture.
		if ('IntersectionObserver' in window) {
			const so = new IntersectionObserver(
				(entries) => {
					for (const e of entries) {
						if (e.isIntersecting) activeStep = Number((e.target as HTMLElement).dataset.step);
					}
				},
				{ rootMargin: '-40% 0px -50% 0px' }
			);
			document.querySelectorAll('[data-step]').forEach((el) => so.observe(el));
			cleanups.push(() => so.disconnect());
		}

		// Caption of the message journey follows the scroll through the pinned section.
		const how = document.querySelector<HTMLElement>('[data-how]');
		const onScroll = () => {
			if (!how) return;
			const r = how.getBoundingClientRect();
			const p = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - innerHeight)));
			howStep = p < 0.2 ? 0 : p < 0.55 ? 1 : p < 0.8 ? 2 : 3;
		};
		window.addEventListener('scroll', onScroll, { passive: true });
		cleanups.push(() => window.removeEventListener('scroll', onScroll));

		// The 3D mark loads after the page has painted, and only when motion is welcome.
		let handle: SceneHandle | null = null;
		let cancelled = false;
		// Phones get the static icon in the hero only: no 3D companion crowding the content.
		const narrow = matchMedia('(max-width: 820px)').matches;
		if (!reduced && !saver && !narrow && canvas) {
			const start = () => {
				if (cancelled || !canvas) return;
				import('./landing-scene')
					.then((m) => {
						if (cancelled || !canvas) return;
						handle = m.createScene(canvas, {
							onReady: () => (glReady = true),
							onFail: () => (glReady = false)
						});
					})
					.catch(() => {
						glReady = false;
					});
			};
			if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 1500 });
			else setTimeout(start, 200);
		}
		return () => {
			cancelled = true;
			handle?.destroy();
			cleanups.forEach((c) => c());
		};
	});
</script>

<svelte:head>
	<title>MIGA — Make Internet Great Again</title>
	<meta
		name="description"
		content="MIGA is an experimental end-to-end encrypted messenger by Vniverse77, built to keep people connected across restricted networks."
	/>
</svelte:head>

<SiteHeader />

<canvas bind:this={canvas} class="stage" class:on={glReady} aria-hidden="true"></canvas>

<div class="page" class:armed class:gl={glReady}>
	<main>
		<!-- HERO -->
		<section class="hero wrap" data-stage>
			<div class="pitch">
				<p class="badge">{t('badge')}</p>
				<h1>MIGA</h1>
				<p class="sub">Make Internet Great Again</p>
				<p class="lead">{t('lead')}</p>
				<div class="cta">
					<a class="btn primary" href="/download/">{t('dp_nav')}<kbd aria-hidden="true">D</kbd></a>
					<a class="btn outline" href="/app/">{t('lp_open_web')}</a>
				</div>
				<ul class="chips">
					<li>{t('lp_chip_1')}</li>
					<li>{t('lp_chip_2')}</li>
					<li>{t('lp_chip_3')}</li>
					<li>{t('lp_chip_4')}</li>
					<li class="ver">{VERSION_LABEL}</li>
				</ul>
			</div>
			<div class="slot" aria-hidden={glReady}>
				<img class="fallback" src="/android-chrome-512x512.png" alt={t('lp_alt_icon')} width="512" height="512" fetchpriority="high" />
			</div>
			<a class="scroll" href="#why" aria-label={t('lp_scroll')}><span>{t('lp_scroll')}</span><i></i></a>
		</section>

		<!-- WHY -->
		<section id="why" class="lane left wrap" data-stage>
			<div class="col">
				<h2 data-reveal>{t('lp_why_title')}</h2>
				<p class="section-lead" data-reveal>{t('lp_why_lead')}</p>
				<div class="stack">
					{#each why as [title, body], i (i)}
						<article class="card" data-reveal style="--d:{i * 70}ms">
							<span class="num">0{i + 1}</span>
							<h3>{title}</h3>
							<p>{body}</p>
						</article>
					{/each}
				</div>
				<aside class="note" data-reveal>
					<h3>{t('lp_limits_title')}</h3>
					<p>{t('lp_limits_text')}</p>
				</aside>
			</div>
		</section>

		<!-- DOWNLOAD AND INSTALL -->
		<section id="install" class="lane right wrap" data-stage>
			<div class="col">
				<h2 data-reveal>{t('lp_inst_title')} <span class="tag">{VERSION_LABEL}</span></h2>
				<p class="section-lead" data-reveal>{t('lp_inst_lead')}</p>

				<div class="tabs" role="tablist" data-reveal>
					{#each ['android', 'linux', 'web', 'windows'] as o (o)}
						<button type="button" role="tab" aria-selected={os === o} class:on={os === o} onclick={() => (os = o as Os)}>
							{o === 'android' ? 'Android' : o === 'linux' ? 'Linux' : o === 'web' ? 'Web' : 'Windows'}
						</button>
					{/each}
				</div>

				<div class="panel card" role="tabpanel" data-reveal>
					{#if os === 'android'}
						<ol class="steps">
							{#each androidSteps as [title, body], i (i)}
								<li>
									<h3>{title}</h3>
									<p>{body}</p>
									{#if i === 2}
										<div class="cmd"><code>{SHA_APK}</code><CopyButton text={SHA_APK} /></div>
									{/if}
								</li>
							{/each}
						</ol>
						<div class="actions">
							<a class="btn primary" href={URLS.apk} download>{t('dl_android_btn')}</a>
							<a class="btn outline" href="/download/">{t('lp_inst_files')}</a>
						</div>
					{:else if os === 'linux'}
						<p class="intro">{t('lp_l_intro')}</p>
						<div class="way">
							<h3>{t('lp_l_deb')}</h3>
							<div class="cmd"><code>{DEB_CMD}</code><CopyButton text={DEB_CMD} /></div>
							<a class="txt" href={URLS.deb}>{t('dp_deb')} →</a>
						</div>
						<div class="way">
							<h3>{t('lp_l_flatpak')}</h3>
							<div class="cmd"><code>{FLATPAK_CMD}</code><CopyButton text={FLATPAK_CMD} /></div>
							<p class="hint">{t('lp_l_flatpak_run')}</p>
							<div class="cmd"><code>{FLATPAK_RUN}</code><CopyButton text={FLATPAK_RUN} /></div>
							<a class="txt" href={URLS.flatpak}>{t('dp_flatpak')} →</a>
						</div>
						<div class="way">
							<h3>{t('lp_l_aur')}</h3>
							<div class="cmd"><code>{YAY}</code><CopyButton text={YAY} /></div>
							<a class="txt" href={URLS.aur}>{t('dl_aur_link')} →</a>
						</div>
						<div class="way">
							<h3>{t('lp_l_verify')}</h3>
							<div class="cmd"><code>{SHA_LINUX}</code><CopyButton text={SHA_LINUX} /></div>
							<a class="txt" href={URLS.sha}>{t('dp_sha')} →</a>
						</div>
						<div class="actions"><a class="btn outline" href="/download/">{t('lp_inst_files')}</a></div>
					{:else if os === 'web'}
						<ol class="steps">
							{#each webSteps as [title, body], i (i)}
								<li><h3>{title}</h3><p>{body}</p></li>
							{/each}
						</ol>
						<div class="actions"><a class="btn primary" href="/app/">{t('dl_web_btn')}</a></div>
					{:else}
						<p class="intro">{t('lp_win_soon')}</p>
						<div class="actions"><a class="btn primary" href="/app/">{t('dl_web_btn')}</a></div>
					{/if}
				</div>
			</div>
		</section>

		<!-- GETTING STARTED -->
		<section id="start" class="lane left wrap" data-stage>
			<div class="col">
				<h2 data-reveal>{t('lp_start_title')}</h2>
				<p class="section-lead" data-reveal>{t('lp_start_lead')}</p>
				<ol class="timeline">
					{#each startSteps as [title, body], i (i)}
						<li data-step={i} class:active={activeStep === i} data-reveal>
							<span class="dot">{i + 1}</span>
							<div>
								<h3>{title}</h3>
								<p>{body}</p>
							</div>
						</li>
					{/each}
				</ol>
			</div>
			<div class="phonecol" aria-hidden="true">
				<div class="phone">
					{#each ['list', 'address', 'chat', 'requests'] as shot (shot)}
						<img src="/landing/{shot}.webp" alt={shotAlt} width="360" height="779" loading="lazy" class:show={phoneShots[activeStep] === shot} />
					{/each}
				</div>
			</div>
			<div class="shots" aria-hidden="true">
				{#each ['list', 'address', 'chat', 'requests'] as shot (shot)}
					<img src="/landing/{shot}.webp" alt={shotAlt} width="360" height="779" loading="lazy" />
				{/each}
			</div>
		</section>

		<!-- FEATURES -->
		<section id="features" class="wrap" data-stage>
			<h2 data-reveal>{t('lp_feat_title')}</h2>
			<p class="section-lead" data-reveal>{t('lp_feat_lead')}</p>
			<div class="grid">
				{#each features as [title, body], i (i)}
					<article class="card feat" data-reveal style="--d:{(i % 3) * 70}ms">
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d={featureIcons[i]} /></svg>
						<h3>{title}</h3>
						<p>{body}</p>
					</article>
				{/each}
			</div>
		</section>

		<!-- HOW IT WORKS: pinned, the 3D scene plays the journey while you scroll -->
		<section id="how" class="how" data-stage data-how>
			<div class="pin">
				<div class="wrap head">
					<h2>{t('lp_how_title')}</h2>
					<p class="section-lead">{t('lp_how_lead')}</p>
				</div>
				<div class="wrap caps">
					{#each howSteps as [title, body], i (i)}
						<article class="cap" class:active={howStep === i}>
							<span class="num">0{i + 1}</span>
							<h3>{title}</h3>
							<p>{body}</p>
						</article>
					{/each}
				</div>
			</div>
		</section>

		<section class="wrap see" data-reveal>
			<div class="card good">
				<h3>{t('lp_blind_title')}</h3>
				<ul>
					<li>{t('lp_blind1')}</li>
					<li>{t('lp_blind2')}</li>
					<li>{t('lp_blind3')}</li>
				</ul>
			</div>
			<div class="card warn">
				<h3>{t('lp_see_title')}</h3>
				<ul>
					<li>{t('lp_see1')}</li>
					<li>{t('lp_see2')}</li>
					<li>{t('lp_see3')}</li>
				</ul>
			</div>
		</section>

		{#if VIDEO_SRC}
			<section class="wrap video" data-reveal>
				<h2>{t('lp_video_title')}</h2>
				<p class="section-lead">{t('lp_video_lead')}</p>
				<!-- svelte-ignore a11y_media_has_caption -->
				<video controls preload="none" poster={VIDEO_POSTER} src={VIDEO_SRC}></video>
			</section>
		{/if}

		<!-- FAQ -->
		<section id="faq" class="lane right wrap" data-stage>
			<div class="col">
				<h2 data-reveal>{t('lp_faq_title')}</h2>
				<div class="faq">
					{#each faq as [q, a], i (i)}
						<details data-reveal style="--d:{(i % 4) * 50}ms">
							<summary>{q}</summary>
							<p>{a}</p>
						</details>
					{/each}
				</div>
			</div>
		</section>

		<!-- END -->
		<section class="lane left wrap endcta" data-stage>
			<div class="col">
				<h2 data-reveal>{t('lp_end_title')}</h2>
				<p class="section-lead" data-reveal>{t('lp_end_lead')}</p>
				<div class="cta" data-reveal>
					<a class="btn primary" href="/download/">{t('dp_nav')}<kbd aria-hidden="true">D</kbd></a>
					<a class="btn outline" href="/app/">{t('lp_open_web')}</a>
				</div>
			</div>
		</section>
	</main>

	<footer>
		<div class="wrap foot">
			<p class="warning">{t('warning')}</p>
			<nav aria-label="Footer">
				<a href="/privacy/">{t('legal_privacy')}</a>
				<a href="/terms/">{t('legal_terms')}</a>
				<a href="/kvkk/">{t('legal_kvkk')}</a>
				<a href="https://github.com/Vniverse77/MIGA">{t('nav_source')}</a>
				<a href="https://forum.vniverse77.com/">Forum</a>
				<a href="https://vniverse77.com/">Vniverse77</a>
			</nav>
		</div>
	</footer>
</div>

<style>
	/* The fixed canvas sits behind all content; the page is above it and clicks pass through. */
	.stage {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100dvh;
		z-index: 0;
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.6s ease;
	}
	.stage:not(.on) {
		visibility: hidden;
	}
	.page {
		position: relative;
		z-index: 1;
	}
	.page :global(h1),
	.page :global(h2),
	.page :global(h3),
	.page :global(p),
	.page :global(li),
	.page :global(summary) {
		overflow-wrap: anywhere;
	}
	.page :global(img) {
		max-width: 100%;
	}
	.col,
	.card,
	.panel {
		min-width: 0;
	}
	.wrap {
		width: 100%;
		max-width: 72rem;
		margin: 0 auto;
		padding: 0 1.5rem;
	}

	/* Entrance animations are armed by script, so the page stays readable without it. */
	.armed :global([data-reveal]:not(.in)) {
		opacity: 0;
		transform: translateY(18px);
	}
	.page :global([data-reveal]) {
		transition:
			opacity 0.7s cubic-bezier(0.2, 0.7, 0.2, 1) var(--d, 0ms),
			transform 0.7s cubic-bezier(0.2, 0.7, 0.2, 1) var(--d, 0ms);
	}

	/* Buttons */
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 2.9rem;
		padding: 0.6rem 1.5rem;
		border: 0.5px solid var(--accent);
		border-radius: var(--radius);
		font-weight: 500;
		text-decoration: none;
		white-space: nowrap;
		transition:
			background-color 0.2s ease,
			color 0.2s ease,
			transform 0.2s ease;
	}
	.btn:hover {
		transform: translateY(-1px);
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
		background: color-mix(in srgb, var(--bg) 60%, transparent);
	}
	.btn.outline:hover {
		background: var(--accent);
		color: var(--accent-ink);
	}
	kbd {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.35rem;
		height: 1.35rem;
		margin-left: 0.6rem;
		padding: 0 0.3rem;
		border: 0.5px solid currentColor;
		border-radius: var(--radius);
		font: inherit;
		font-size: 0.7rem;
		line-height: 1;
	}
	.cta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	/* Hero */
	.hero {
		position: relative;
		display: grid;
		grid-template-columns: 1.05fr 0.95fr;
		align-items: center;
		gap: 2rem;
		min-height: calc(100dvh - 3.5rem);
		padding-top: 2rem;
		padding-bottom: 4rem;
	}
	.badge {
		margin: 0 0 1rem;
		color: var(--link);
		font-size: 0.85rem;
		letter-spacing: 0.02em;
	}
	h1 {
		margin: 0 0 0.6rem;
		color: var(--heading);
		font-size: clamp(3rem, 10vw, 5.4rem);
		font-weight: 800;
		letter-spacing: 0.08em;
		line-height: 1;
	}
	.sub {
		margin: 0 0 1.4rem;
		color: var(--text);
		font-size: clamp(1.1rem, 2.6vw, 1.6rem);
		font-weight: 600;
	}
	.lead {
		margin: 0 0 2rem;
		max-width: 33rem;
		color: var(--text);
		opacity: 0.85;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 2rem 0 0;
		padding: 0;
		list-style: none;
	}
	.chips li {
		padding: 0.2rem 0.65rem;
		border: 0.5px solid var(--line-strong);
		border-radius: 999px;
		color: var(--muted);
		font-size: 0.75rem;
		background: color-mix(in srgb, var(--bg) 70%, transparent);
	}
	.slot {
		display: grid;
		place-items: center;
		min-height: 20rem;
	}
	.fallback {
		width: min(26rem, 100%);
		height: auto;
		border-radius: 22%;
		transition: opacity 0.5s ease;
	}
	.gl .fallback {
		opacity: 0;
	}
	.scroll {
		position: absolute;
		left: 50%;
		bottom: 1.2rem;
		transform: translateX(-50%);
		display: grid;
		justify-items: center;
		gap: 0.4rem;
		color: var(--muted);
		font-size: 0.7rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		text-decoration: none;
	}
	.scroll i {
		width: 1px;
		height: 2rem;
		background: linear-gradient(var(--accent-2), transparent);
		animation: drip 2.2s ease-in-out infinite;
		transform-origin: top;
	}
	@keyframes drip {
		0% {
			transform: scaleY(0);
		}
		60% {
			transform: scaleY(1);
		}
		100% {
			transform: scaleY(1);
			opacity: 0;
		}
	}

	/* Sections */
	section:not(.hero) {
		padding-top: 6rem;
		padding-bottom: 1rem;
	}
	section:not(.hero).how {
		padding: 0;
	}
	h2 {
		margin: 0 0 0.5rem;
		color: var(--heading);
		font-size: clamp(1.6rem, 4vw, 2.4rem);
		line-height: 1.15;
	}
	h3 {
		margin: 0 0 0.4rem;
		color: var(--heading);
		font-size: 1rem;
	}
	.section-lead {
		margin: 0 0 2rem;
		max-width: 38rem;
		color: var(--muted);
	}
	.tag {
		vertical-align: middle;
		margin-left: 0.4rem;
		padding: 0.05rem 0.4rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		color: var(--muted);
		font-size: 0.7rem;
		font-weight: 500;
	}

	/* Lanes: text on one side, the 3D mark on the other (it flies there as you scroll). */
	.lane {
		display: grid;
		grid-template-columns: repeat(12, 1fr);
		gap: 0 1.5rem;
	}
	.lane.left .col {
		grid-column: 1 / 8;
	}
	.lane.right .col {
		grid-column: 6 / 13;
	}
	.lane .phonecol {
		grid-column: 9 / 13;
		grid-row: 1;
	}

	.card,
	.note {
		padding: 1.25rem;
		border: 0.5px solid var(--line);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--panel) 92%, transparent);
		backdrop-filter: blur(6px);
	}
	.card p,
	.note p {
		margin: 0;
		color: var(--muted);
		font-size: 0.9rem;
	}
	.stack {
		display: grid;
		gap: 0.8rem;
	}
	.stack .card {
		position: relative;
		padding-left: 4rem;
	}
	.num {
		color: var(--link);
		font-size: 0.8rem;
	}
	.stack .num {
		position: absolute;
		left: 1.25rem;
		top: 1.3rem;
	}
	.note {
		margin-top: 1rem;
		border-color: color-mix(in srgb, var(--danger) 40%, transparent);
	}
	.note h3 {
		color: var(--danger);
	}
	.note p {
		color: var(--text);
		opacity: 0.85;
	}

	/* Install */
	.tabs {
		display: flex;
		gap: 0.4rem;
		margin-bottom: 0.8rem;
		overflow-x: auto;
	}
	.tabs button {
		min-height: 2.75rem;
		padding: 0.5rem 1rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--bg) 70%, transparent);
		color: var(--muted);
		cursor: pointer;
		transition:
			background-color 0.2s ease,
			color 0.2s ease;
	}
	.tabs button.on {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-ink);
	}
	.steps {
		display: grid;
		gap: 1rem;
		margin: 0 0 1.25rem;
		padding: 0;
		list-style: none;
		counter-reset: s;
		grid-template-columns: minmax(0, 1fr);
	}
	.steps li {
		position: relative;
		padding-left: 2.6rem;
		counter-increment: s;
	}
	.steps li::before {
		content: counter(s);
		position: absolute;
		left: 0;
		top: 0;
		display: grid;
		place-items: center;
		width: 1.7rem;
		height: 1.7rem;
		border: 0.5px solid var(--line-strong);
		border-radius: 50%;
		color: var(--link);
		font-size: 0.8rem;
	}
	.card .intro {
		margin: 0 0 1.25rem;
		color: var(--text);
		font-size: 0.9rem;
	}
	.way {
		padding: 0.9rem 0;
		border-top: 0.5px solid var(--line);
	}
	.steps .cmd {
		margin-bottom: 0;
	}
	.hint {
		margin: 0.6rem 0 0.4rem !important;
	}
	.cmd {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.5rem 0;
	}
	.cmd code {
		flex: 1;
		min-width: 0;
		padding: 0.75rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--text);
		font-size: 0.85rem;
		overflow-x: auto;
		white-space: nowrap;
		-webkit-overflow-scrolling: touch;
	}
	.txt {
		font-size: 0.85rem;
		text-decoration: none;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-top: 1rem;
	}

	/* Getting started */
	.timeline {
		display: grid;
		gap: 1.6rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.timeline li {
		position: relative;
		display: grid;
		grid-template-columns: 2.4rem 1fr;
		gap: 0.8rem;
		opacity: 0.6;
		transition: opacity 0.3s ease;
	}
	.timeline li.active {
		opacity: 1;
	}
	.timeline p {
		margin: 0;
		color: var(--muted);
		font-size: 0.9rem;
	}
	.dot {
		display: grid;
		place-items: center;
		width: 2.2rem;
		height: 2.2rem;
		border: 0.5px solid var(--line-strong);
		border-radius: 50%;
		background: var(--bg);
		color: var(--link);
		transition:
			background-color 0.3s ease,
			color 0.3s ease;
	}
	.active .dot {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-ink);
	}
	.phonecol {
		position: relative;
	}
	.phone {
		position: sticky;
		top: 5.5rem;
		width: min(17rem, 100%);
		aspect-ratio: 360 / 779;
		margin: 0 auto;
		border: 6px solid #13203a;
		border-radius: 2.2rem;
		outline: 0.5px solid var(--line-strong);
		background: #070b14;
		overflow: hidden;
		box-shadow: 0 30px 60px -30px rgba(0, 0, 0, 0.8);
	}
	.phone img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		opacity: 0;
		transition: opacity 0.45s ease;
	}
	.phone img.show {
		opacity: 1;
	}
	.shots {
		display: none;
	}

	/* Features */
	.grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.9rem;
	}
	.feat svg {
		width: 1.6rem;
		height: 1.6rem;
		margin-bottom: 0.8rem;
		fill: none;
		stroke: var(--accent-2);
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.feat {
		transition:
			border-color 0.25s ease,
			transform 0.7s cubic-bezier(0.2, 0.7, 0.2, 1);
	}
	.feat:hover {
		border-color: var(--line-strong);
	}

	/* How it works: a tall section with a pinned stage; the canvas plays the journey behind it */
	.how {
		height: 340vh;
	}
	.pin {
		position: sticky;
		top: 0;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		height: 100dvh;
		padding: 5.5rem 0 2rem;
	}
	.caps {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.8rem;
	}
	.cap {
		padding: 1rem;
		border: 0.5px solid var(--line);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--panel) 85%, transparent);
		backdrop-filter: blur(6px);
		opacity: 0.45;
		transition:
			opacity 0.35s ease,
			border-color 0.35s ease,
			transform 0.35s ease;
	}
	.cap.active {
		opacity: 1;
		border-color: var(--accent-2);
		transform: translateY(-4px);
	}
	.cap p {
		margin: 0;
		color: var(--muted);
		font-size: 0.85rem;
	}
	.see {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.9rem;
		padding-top: 2rem !important;
	}
	.see ul {
		margin: 0;
		padding-left: 1.1rem;
		color: var(--text);
		font-size: 0.9rem;
	}
	.see li {
		margin: 0.3rem 0;
	}
	.see .good {
		border-color: color-mix(in srgb, var(--accent-2) 50%, transparent);
	}
	.see .warn {
		border-color: color-mix(in srgb, var(--danger) 40%, transparent);
	}
	.video video {
		width: 100%;
		border: 0.5px solid var(--line);
		border-radius: var(--radius-lg);
		background: #000;
	}

	/* FAQ */
	.faq {
		display: grid;
		gap: 0.6rem;
		margin-top: 1.5rem;
	}
	details {
		border: 0.5px solid var(--line);
		border-radius: var(--radius-lg);
		background: color-mix(in srgb, var(--panel) 92%, transparent);
		backdrop-filter: blur(6px);
		transition: border-color 0.25s ease;
	}
	details[open] {
		border-color: var(--line-strong);
	}
	summary {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.9rem 1.1rem;
		color: var(--heading);
		cursor: pointer;
		list-style: none;
		font-size: 0.92rem;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary::after {
		content: '+';
		color: var(--link);
		transition: transform 0.25s ease;
	}
	details[open] summary::after {
		transform: rotate(45deg);
	}
	details p {
		margin: 0;
		padding: 0 1.1rem 1rem;
		color: var(--muted);
		font-size: 0.88rem;
	}

	/* Footer */
	footer {
		margin-top: 6rem;
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
	footer nav {
		display: flex;
		flex-wrap: wrap;
		gap: 1.25rem;
	}
	footer a {
		color: var(--muted);
		font-size: 0.9rem;
		text-decoration: none;
	}
	footer a:hover {
		color: var(--link);
	}

	@media (max-width: 980px) {
		.lane.left .col {
			grid-column: 1 / 9;
		}
		.lane.right .col {
			grid-column: 4 / 13;
		}
	}

	/* Phones and narrow windows: one column, the mark is a small companion in the corner. */
	@media (max-width: 820px) {
		.wrap {
			padding: 0 1rem;
		}
		.hero {
			grid-template-columns: 1fr;
			gap: 0;
			min-height: calc(100dvh - 3.5rem);
			align-content: start;
			padding-top: 0;
			padding-bottom: 3rem;
		}
		/* The slot holds the picture above the text; the 3D mark sits over it. */
		.slot {
			order: -1;
			min-height: 0;
			height: 34dvh;
		}
		.fallback {
			height: 100%;
			width: auto;
			max-width: 70%;
		}
		.scroll {
			display: none;
		}
		.chips {
			margin-top: 1.4rem;
		}
		section:not(.hero) {
			padding-top: 4rem;
		}
		section:not(.hero).how {
			padding: 0;
		}
		.lane {
			display: block;
		}
		.phonecol {
			display: none;
		}
		.shots {
			display: flex;
			gap: 0.7rem;
			margin: 1.6rem -1rem 0;
			padding: 0 1rem 0.5rem;
			overflow-x: auto;
			scroll-snap-type: x mandatory;
		}
		.shots img {
			flex: 0 0 76%;
			width: 76%;
			height: auto;
			border: 0.5px solid var(--line-strong);
			border-radius: 1.2rem;
			scroll-snap-align: center;
		}
		.stack .card {
			padding-left: 3.4rem;
		}
		.grid,
		.see {
			grid-template-columns: 1fr;
		}
		/* No 3D journey on phones: the four steps are a plain stacked list, no pinned empty stage. */
		.how {
			height: auto;
		}
		.pin {
			position: static;
			height: auto;
			display: block;
			padding: 4rem 0 0;
		}
		.caps {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			gap: 0.8rem;
		}
		.cap {
			opacity: 1;
		}
		.cap.active {
			transform: none;
			border-color: var(--line);
		}
		.cta .btn {
			flex: 1 1 100%;
		}
		kbd {
			display: none;
		}
		.slot {
			margin-bottom: 1.25rem;
		}
		.foot {
			flex-direction: column;
			align-items: flex-start;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.scroll i {
			animation: none;
		}
		.page :global([data-reveal]),
		.cap,
		.btn {
			transition: none;
		}
	}
</style>
