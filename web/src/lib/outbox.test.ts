import { afterSend, FAIL_AFTER_MS, nextStep, retryDelay } from './outbox.ts';

const eq = (a: unknown, b: unknown) => {
	if (a !== b) throw new Error(`expected ${b}, got ${a}`);
};

Deno.test('backoff: 2 s, 5 s, 15 s, 30 s, then every 60 s', () => {
	eq([1, 2, 3, 4, 5, 6, 50].map(retryDelay).join(','), '2000,5000,15000,30000,60000,60000,60000');
});

Deno.test('state machine: pending waits, sends when due, fails after 24 h', () => {
	const m = { state: 'pending', ts: 1_000 };
	eq(nextStep(m, undefined, 1_000), 'send');
	const t1 = afterSend(undefined, 1_000);
	eq(t1.nextAt, 3_000);
	eq(nextStep(m, t1, 2_999), 'wait');
	eq(nextStep(m, t1, 3_000), 'send');
	const t2 = afterSend(t1, 3_000);
	eq(t2.attempts, 2);
	eq(t2.nextAt, 8_000);
	eq(nextStep(m, { attempts: 9, nextAt: Infinity }, 1_000 + FAIL_AFTER_MS - 1), 'wait');
	eq(nextStep(m, { attempts: 9, nextAt: Infinity }, 1_000 + FAIL_AFTER_MS), 'fail');
});

Deno.test('state machine: only pending messages are touched; a manual retry restarts the 24 h clock', () => {
	eq(nextStep({ state: 'sent', ts: 0 }, undefined, 5), 'skip');
	eq(nextStep({ state: 'failed', ts: 0 }, undefined, 5), 'skip');
	const now = FAIL_AFTER_MS + 10;
	eq(nextStep({ state: 'pending', ts: 0 }, undefined, now), 'fail');
	eq(nextStep({ state: 'pending', ts: 0, retried: now - 1 }, undefined, now), 'send');
});
