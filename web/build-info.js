// @ts-nocheck  (plain Node script, read by vite.config.ts)
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// Version shown next to the name and published as /version.json, so anyone can check
// which build a relay is serving: `curl https://<host>/version.json`.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
let commit = 'dev';
try {
	commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
	// not a git checkout: keep "dev"
}
export const target = ['desktop', 'mobile'].includes(process.env.MIGA_TARGET ?? '') ? process.env.MIGA_TARGET : 'web';
export const info = { target, version: pkg.version, commit, built: new Date().toISOString().slice(0, 16) + 'Z' };
writeFileSync(new URL('./static/version.json', import.meta.url), JSON.stringify(info) + '\n');

