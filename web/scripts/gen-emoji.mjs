// Builds src/lib/app/emoji-data.json from the unicode-emoji-json package (MIT).
// Run by hand after updating that devDependency: node scripts/gen-emoji.mjs
// Skin-tone variants and emoji newer than Unicode Emoji 15.0 are left out (older fonts show them as boxes).
import { readFileSync, writeFileSync } from 'node:fs';

const groups = JSON.parse(readFileSync('node_modules/unicode-emoji-json/data-by-group.json', 'utf8'));
const MAX_VERSION = 15.0;
const out = groups
	.filter((g) => g.slug !== 'component')
	.map((g) => ({
		id: g.slug,
		e: g.emojis
			.filter((x) => Number(x.emoji_version) <= MAX_VERSION)
			.map((x) => [x.emoji, x.name])
	}));
writeFileSync('src/lib/app/emoji-data.json', JSON.stringify(out));
console.log(out.map((g) => g.id + ':' + g.e.length).join(' '));
