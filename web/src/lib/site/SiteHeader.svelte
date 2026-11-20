<script lang="ts">
	import { VERSION_LABEL, VERSION_TITLE } from '../version';
	import Logo from '../Logo.svelte';
	import LangSelect from '../LangSelect.svelte';
	import { t } from '../i18n.svelte';

	// Shared top bar of the public pages. The D key opens /download (see +layout.svelte).
	let { current = '' }: { current?: 'download' | '' } = $props();
</script>

<header class="top">
	<div class="wrap bar">
		<a class="brand" href="/">
			<Logo size={30} />
			<span>MIGA</span>
			<span class="ver" title={VERSION_TITLE}>{VERSION_LABEL}</span>
		</a>
		<nav aria-label="Main">
			<a class="link" href="https://vniverse77.com/">Vniverse77</a>
			<a class="link" href="https://forum.vniverse77.com/">Forum</a>
			<a class="link" href="https://github.com/Vniverse77/MIGA">{t('nav_source')}</a>
			<LangSelect />
			<a
				class="btn outline small"
				href="/download/"
				aria-keyshortcuts="D"
				aria-current={current === 'download' ? 'page' : undefined}
			>
				<span>{t('dp_nav')}</span><kbd aria-hidden="true">D</kbd>
			</a>
			<a class="btn primary small" href="/app/">{t('nav_app')}</a>
		</nav>
	</div>
</header>

<style>
	.wrap {
		width: 100%;
		max-width: 68rem;
		margin: 0 auto;
		padding: 0 1.5rem;
	}
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
		color: var(--link);
	}
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.55rem;
		padding: 0.4rem 0.9rem;
		border: 0.5px solid var(--accent);
		border-radius: var(--radius);
		font-size: 0.9rem;
		font-weight: 700;
		text-decoration: none;
		white-space: nowrap;
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
	.btn.outline:hover,
	.btn.outline[aria-current='page'] {
		background: var(--accent);
		color: var(--accent-ink);
	}
	kbd {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.35rem;
		height: 1.35rem;
		padding: 0 0.3rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		color: var(--muted);
		font: inherit;
		font-size: 0.7rem;
		font-weight: 500;
		line-height: 1;
	}
	.btn:hover kbd,
	.btn[aria-current='page'] kbd {
		border-color: currentColor;
		color: inherit;
	}
	@media (max-width: 820px) {
		.link,
		kbd {
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
		.btn {
			padding: 0.4rem 0.7rem;
		}
	}
	/* Phones: the bar must never be wider than the screen, in any language. */
	@media (max-width: 520px) {
		.brand {
			flex: 0 0 auto;
		}
		.brand span {
			display: none;
		}
		nav > :global(*) {
			min-width: 0;
		}
		.btn {
			flex: 0 1 auto;
			min-width: 0;
			min-height: 2.75rem;
			padding: 0.3rem 0.6rem;
			font-size: 0.8rem;
			line-height: 1.15;
			text-align: center;
			white-space: normal;
		}
	}
</style>
