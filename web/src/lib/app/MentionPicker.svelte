<script lang="ts">
	// The member list that opens above the composer after "@". Keyboard: the composer handles arrows/Enter/Esc and passes `index`.
	import { t } from '../i18n.svelte';
	import { MEMBER_COLORS } from '../group-ui';

	type Item = { address: string; name: string; color: number; src: string };
	let { items, index, onpick }: { items: Item[]; index: number; onpick: (address: string) => void } = $props();
	void MEMBER_COLORS;
</script>

<ul class="mp" role="listbox" aria-label={t('g_mention_pick')} data-mention-picker>
	{#each items as it, i (it.address)}
		<li role="option" aria-selected={i === index}>
			<!-- pointerdown keeps the focus in the composer (a click would blur the text field and close the keyboard) -->
			<button type="button" class:on={i === index} tabindex="-1" data-mention={it.address} onpointerdown={(e) => (e.preventDefault(), onpick(it.address))}>
				<img src={it.src} alt="" />
				<span style:color="var(--gm-{it.color})">{it.name}</span>
			</button>
		</li>
	{/each}
</ul>

<style>
	.mp {
		display: grid;
		gap: 1px;
		margin: 0;
		padding: 0.25rem;
		list-style: none;
		max-height: 12.5rem;
		overflow-y: auto;
		border-top: 0.5px solid var(--line);
		background: var(--panel);
	}
	button {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		min-height: 44px;
		padding: 0.2rem 0.5rem;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text);
		font-size: var(--fs-body);
		text-align: left;
		cursor: pointer;
	}
	button:hover,
	button.on {
		background: var(--panel-2);
	}
	img {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
		image-rendering: pixelated;
	}
	span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
</style>
