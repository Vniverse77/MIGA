<script lang="ts">
	/**
	 * One small inline icon set: 24 grid, 2 px stroke, round caps and joins, currentColor.
	 * Decorative: the surrounding button carries the aria-label and title.
	 */
	export type IconName =
		| 'send'
		| 'settings'
		| 'plus'
		| 'back'
		| 'copy'
		| 'trash'
		| 'reply'
		| 'edit'
		| 'close'
		| 'scan'
		| 'device-add'
		| 'bell'
		| 'bell-off'
		| 'check'
		| 'shield'
		| 'block'
		| 'user-x'
		| 'download'
		| 'more'
		| 'more-v';

	let { name, size = 20 }: { name: IconName; size?: number } = $props();
</script>

<svg
	class="icon"
	viewBox="0 0 24 24"
	width={size}
	height={size}
	aria-hidden="true"
	focusable="false"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
>
	{#if name === 'send'}
		<path d="M21 3 10 14" />
		<path d="M21 3l-7 18-4-7-7-4z" />
	{:else if name === 'settings'}
		<path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
		<circle cx="15" cy="7" r="2" />
		<circle cx="9" cy="17" r="2" />
	{:else if name === 'plus'}
		<path d="M12 5v14M5 12h14" />
	{:else if name === 'back'}
		<path d="M15 5l-7 7 7 7" />
	{:else if name === 'copy'}
		<rect x="9" y="9" width="11" height="11" rx="2" />
		<path d="M5 15V6a2 2 0 0 1 2-2h8" />
	{:else if name === 'trash'}
		<path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v5M14 11v5" />
	{:else if name === 'reply'}
		<path d="M9 14 4 9l5-5" />
		<path d="M4 9h10a6 6 0 0 1 6 6v3" />
	{:else if name === 'edit'}
		<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
		<path d="M13.5 6.5l4 4" />
	{:else if name === 'close'}
		<path d="M6 6l12 12M18 6L6 18" />
	{:else if name === 'scan'}
		<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
		<path d="M8 12h8" />
	{:else if name === 'device-add'}
		<rect x="3" y="5" width="13" height="10" rx="2" />
		<path d="M1 19h17M19 9v6M16 12h6" />
	{:else if name === 'bell'}
		<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4" />
	{:else if name === 'bell-off'}
		<path d="M8.7 4.6A6 6 0 0 1 18 11v4M6 11v5l-2 2h13M10 21h4M3 3l18 18" />
	{:else if name === 'check'}
		<path d="M5 12.5l4.5 4.5L19 7" />
	{:else if name === 'shield'}
		<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" />
		<path d="M8.5 12l2.5 2.5L15.5 10" />
	{:else if name === 'block'}
		<circle cx="12" cy="12" r="9" />
		<path d="M5.6 5.6l12.8 12.8" />
	{:else if name === 'user-x'}
		<circle cx="9" cy="8" r="4" />
		<path d="M2 20a7 7 0 0 1 12-4.5M17 9l5 5M22 9l-5 5" />
	{:else if name === 'download'}
		<path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
	{:else if name === 'more'}
		<circle cx="5" cy="12" r="1" />
		<circle cx="12" cy="12" r="1" />
		<circle cx="19" cy="12" r="1" />
	{:else if name === 'more-v'}
		<circle cx="12" cy="5" r="1" />
		<circle cx="12" cy="12" r="1" />
		<circle cx="12" cy="19" r="1" />
	{/if}
</svg>

<style>
	.icon {
		display: block;
		flex: none;
		pointer-events: none;
	}
</style>
