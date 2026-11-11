// Build identity, injected at build time (see vite.config.ts). The same data is served as /version.json.
export const BUILD = __MIGA_BUILD__;
export const VERSION_LABEL = `v${BUILD.version}`;
export const VERSION_TITLE = `MIGA ${BUILD.version} · ${BUILD.commit} · ${BUILD.built}`;

/** Asks the server which build it serves now. Resolves to true when it differs from the running one. */
export async function newerBuildOnServer(): Promise<boolean> {
	try {
		const res = await fetch('/version.json', { cache: 'no-store' });
		if (!res.ok) return false;
		const remote = (await res.json()) as typeof BUILD;
		return remote.commit !== BUILD.commit || remote.built !== BUILD.built;
	} catch {
		return false; // offline or blocked: keep running what we have
	}
}
