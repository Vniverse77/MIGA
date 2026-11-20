// Web Worker for pow.ts: finds a nonce without blocking the interface.
import { solveSlice } from './pow';

type Job = { sender: string; recipient: string; day: number; bits: number };

self.onmessage = (e: MessageEvent<Job>) => {
	const { sender, recipient, day, bits } = e.data;
	for (let from = 0; ; from += 50_000) {
		const n = solveSlice(sender, recipient, day, from, 50_000, bits);
		if (n !== null) {
			(self as unknown as { postMessage(n: number): void }).postMessage(n);
			return;
		}
	}
};
