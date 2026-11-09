<svelte:head>
	<title>MIGA — Make Internet Great Again</title>
	<meta
		name="description"
		content="MIGA is an experimental end-to-end encrypted messenger built to keep people connected across restricted networks."
	/>
</svelte:head>

<main>
	<p class="badge">Test phase</p>
	<h1>MIGA</h1>
	<p class="tagline">Make Internet Great Again</p>
	<p class="lead">
		A messenger built to keep people connected across restricted networks. No phone number, no
		e-mail, no account: your identity is a key that never leaves your device.
	</p>
	<a class="cta" href="/app/">Open MIGA in your browser</a>

	<section>
		<article>
			<h2>End-to-end encrypted</h2>
			<p>Messages are encrypted on your device. The relay only passes sealed envelopes along.</p>
		</article>
		<article>
			<h2>Looks like ordinary web traffic</h2>
			<p>Everything travels over standard HTTPS on port 443, like any other website.</p>
		</article>
		<article>
			<h2>No central account</h2>
			<p>The relay is replaceable. Anyone can run one, and your key works with all of them.</p>
		</article>
	</section>

	<p class="warning">
		MIGA is experimental and has not been security-audited. Do not rely on it yet where your
		safety depends on it.
	</p>
</main>

<style>
	main {
		max-width: 46rem;
		margin: 0 auto;
		padding: 4rem 1.25rem 3rem;
		text-align: center;
	}
	.badge {
		display: inline-block;
		margin: 0;
		padding: 0.15rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		color: var(--muted);
		font-size: 0.85rem;
	}
	h1 {
		margin: 1rem 0 0;
		font-size: clamp(3rem, 12vw, 5.5rem);
		letter-spacing: 0.08em;
		line-height: 1;
	}
	.tagline {
		margin: 0.5rem 0 1.5rem;
		color: var(--accent);
		font-size: 1.2rem;
	}
	.lead {
		margin: 0 auto 2rem;
		max-width: 34rem;
		color: var(--muted);
		font-size: 1.1rem;
	}
	.cta {
		display: inline-block;
		padding: 0.8rem 1.6rem;
		border-radius: 0.6rem;
		background: var(--accent);
		color: var(--accent-ink);
		font-weight: 600;
		text-decoration: none;
	}
	section {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
		gap: 1rem;
		margin: 3.5rem 0 2rem;
		text-align: left;
	}
	article {
		padding: 1.1rem;
		border: 1px solid var(--line);
		border-radius: 0.8rem;
		background: var(--panel);
	}
	h2 {
		margin: 0 0 0.4rem;
		font-size: 1.05rem;
	}
	article p {
		margin: 0;
		color: var(--muted);
		font-size: 0.95rem;
	}
	.warning {
		color: var(--muted);
		font-size: 0.9rem;
	}
</style>
