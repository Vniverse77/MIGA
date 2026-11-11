import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { info, target } from './build-info.js';

export default defineConfig({
	define: { __MIGA_BUILD__: JSON.stringify(info), __MIGA_TARGET__: JSON.stringify(target) },
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Fully static output: the Go relay (or any file server) serves web/build as is.
			// One output folder per target: build (web), build-desktop, build-mobile.
			adapter: adapter(target === 'web' ? {} : { pages: `build-${target}`, assets: `build-${target}` })
		})
	],
	server: {
		// In development the relay runs separately on :8787.
		proxy: { '/ws': { target: 'http://127.0.0.1:8787', ws: true } }
	}
});
