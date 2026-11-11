/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
// Keeps a copy of the app on the device, so it still opens when the site cannot be reached
// (blocked, offline, slow). Pages are fetched from the network first, so a reachable server
// always wins; the copy is only the fallback. Messages never pass through here: the relay
// connection is a WebSocket, which service workers do not see.
import { assets, immutable, prerendered } from '$app/manifest';
import { version } from '$app/env';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `miga-${version}`;
// The manifest lists entries as { path } relative to the site root.
const toPath = (e: { path: string }) => '/' + e.path;
const HASHED = new Set<string>(immutable.map(toPath)); // content-hashed names: safe to serve from cache
const SHELL = [
	...immutable.map(toPath),
	...assets.map(toPath).filter((f: string) => f !== '/version.json'),
	...prerendered.map(toPath)
];

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(SHELL))
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => sw.clients.claim())
	);
});

sw.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== sw.location.origin) return;
	if (url.pathname === '/version.json' || url.pathname.startsWith('/ws')) return; // always live

	event.respondWith(
		(async () => {
			let cache: Cache | undefined;
			try {
				cache = await caches.open(CACHE);
				if (HASHED.has(url.pathname)) {
					const hit = await cache.match(url.pathname);
					if (hit) return hit;
				}
			} catch {
				// cache storage unavailable (private window, quota): behave as if there were no worker
			}
			try {
				const res = await fetch(req);
				if (cache && res.status === 200) cache.put(url.pathname, res.clone()).catch(() => {});
				return res;
			} catch (err) {
				const path = url.pathname;
				const alt = path.endsWith('/') ? path.slice(0, -1) : path + '/';
				const hit = cache && ((await cache.match(path)) ?? (await cache.match(alt)));
				if (hit) return hit;
				throw err;
			}
		})()
	);
});
