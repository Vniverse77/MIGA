// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	/** Injected by vite.config.ts at build time. */
	const __MIGA_BUILD__: { version: string; commit: string; built: string; target: string };
	const __MIGA_TARGET__: 'web' | 'desktop' | 'mobile';
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
