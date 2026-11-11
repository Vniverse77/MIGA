import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { info } from './build-info.js';

export default defineConfig({
	define: { __MIGA_BUILD__: JSON.stringify(info) },
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Fully static output: the Go relay (or any file server) serves web/build as is.
			adapter: adapter()
		})
	],
	server: {
		// In development the relay runs separately on :8787.
		proxy: { '/ws': { target: 'http://127.0.0.1:8787', ws: true } }
	}
});
