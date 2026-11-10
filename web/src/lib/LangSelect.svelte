<script lang="ts">
	import { getLanguage, languages, setLanguage, t, type Lang } from './i18n.svelte';
</script>

<select
	aria-label={t('language')}
	value={getLanguage()}
	onchange={(event) => setLanguage(event.currentTarget.value as Lang)}
>
	{#each languages as language (language.code)}
		<option value={language.code}>{language.name}</option>
	{/each}
</select>

<style>
	select {
		padding: 0.35rem 0.5rem;
		border: 0.5px solid var(--line-strong);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}
</style>
