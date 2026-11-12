<script lang="ts">
	import Landing from '../lib/site/Landing.svelte';
	import Messenger from '../lib/app/Messenger.svelte';
</script>

{#if __MIGA_TARGET__ === 'web'}
	<Landing />
{:else}
	<Messenger />
{/if}
