import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchConcurrency, createStartGate, runPool } from '../../shared/batch';

const tick = async () => {
	for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe('runPool', () => {
	it('caps the number of in-flight workers and keeps result order', async () => {
		let inFlight = 0;
		let peak = 0;
		const outcome = await runPool(
			7,
			3,
			async (i) => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await tick();
				inFlight--;
				return i * 10;
			},
			{ stopOnError: false },
		);
		expect(peak).toBe(3);
		expect(outcome.results.map((r) => (r?.ok ? r.value : null))).toEqual([
			0, 10, 20, 30, 40, 50, 60,
		]);
		expect(outcome.firstError).toBeUndefined();
	});

	it('collects every failure when not stopping on error', async () => {
		const outcome = await runPool(
			3,
			2,
			async (i) => {
				if (i === 1) throw new Error('boom');
				return i;
			},
			{ stopOnError: false },
		);
		expect(outcome.results.map((r) => r?.ok)).toEqual([true, false, true]);
	});

	it('aborts siblings and stops scheduling after the first failure', async () => {
		const started: number[] = [];
		const aborted: number[] = [];
		const outcome = await runPool(
			6,
			2,
			async (i, signal) => {
				started.push(i);
				if (i === 0) {
					await tick();
					throw new Error('first');
				}
				await new Promise<void>((_, reject) =>
					signal.addEventListener('abort', () => {
						aborted.push(i);
						reject(new Error('aborted'));
					}),
				);
			},
			{ stopOnError: true },
		);
		expect(outcome.firstError?.index).toBe(0);
		expect(outcome.firstError?.error.message).toBe('first');
		expect(started).toEqual([0, 1]);
		expect(aborted).toEqual([1]);
		expect(outcome.results.slice(2)).toEqual([undefined, undefined, undefined, undefined]);
	});

	it('stops when the parent signal aborts', async () => {
		const parent = new AbortController();
		parent.abort();
		const worker = vi.fn(async () => 1);
		const outcome = await runPool(3, 2, worker, { stopOnError: false, signal: parent.signal });
		expect(worker).not.toHaveBeenCalled();
		expect(outcome.results).toEqual([undefined, undefined, undefined]);
	});
});

describe('createStartGate', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('spaces consecutive starts by the cool-off', async () => {
		const gate = createStartGate(1_000);
		const times: number[] = [];
		const t0 = Date.now();
		const all = Promise.all(
			[0, 1, 2].map(async () => {
				await gate();
				times.push(Date.now() - t0);
			}),
		);
		await vi.advanceTimersByTimeAsync(5_000);
		await all;
		expect(times).toEqual([0, 1_000, 2_000]);
	});
});

describe('batchConcurrency', () => {
	it.each([
		[3, 25, 0, 3],
		[10, 25, 0, 10],
		[50, 25, 0, 10],
		[3, 25, 24, 1],
		[3, 25, 25, 1],
		[3, 2, 0, 2],
		[undefined, undefined, undefined, 3],
		[0, 25, 0, 3],
	])('requested %s, max %s, current %s → %s', (req, max, cur, expected) => {
		expect(batchConcurrency(req, max, cur)).toBe(expected);
	});
});
