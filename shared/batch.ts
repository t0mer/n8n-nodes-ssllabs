import { sleep as n8nSleep } from 'n8n-workflow';

export type PoolResult<T> = { ok: true; value: T } | { ok: false; error: Error };

export interface PoolOptions {
	/** Parent cancellation (e.g. the execution's cancel signal). */
	signal?: AbortSignal;
	/** Abort in-flight siblings and stop starting new work after the first failure. */
	stopOnError: boolean;
}

export interface PoolOutcome<T> {
	/** One entry per index; undefined for work that never started (stopped or cancelled). */
	results: Array<PoolResult<T> | undefined>;
	firstError?: { index: number; error: Error };
}

/** Runs `worker(index)` for 0..count-1 with at most `concurrency` in flight. */
export async function runPool<T>(
	count: number,
	concurrency: number,
	worker: (index: number, signal: AbortSignal) => Promise<T>,
	options: PoolOptions,
): Promise<PoolOutcome<T>> {
	const controller = new AbortController();
	const onParentAbort = () => controller.abort();
	if (options.signal?.aborted) controller.abort();
	options.signal?.addEventListener('abort', onParentAbort, { once: true });

	const outcome: PoolOutcome<T> = { results: new Array(count).fill(undefined) };
	let next = 0;

	const runWorker = async () => {
		while (next < count && !controller.signal.aborted) {
			const index = next++;
			try {
				outcome.results[index] = { ok: true, value: await worker(index, controller.signal) };
			} catch (error) {
				outcome.results[index] = { ok: false, error: error as Error };
				if (options.stopOnError && !outcome.firstError) {
					outcome.firstError = { index, error: error as Error };
					controller.abort();
				}
			}
		}
	};

	try {
		const workers = Math.max(1, Math.min(concurrency, count));
		await Promise.all(Array.from({ length: workers }, runWorker));
	} finally {
		options.signal?.removeEventListener('abort', onParentAbort);
	}
	return outcome;
}

/**
 * Serializes assessment starts so that consecutive starts are at least `coolOffMs` apart
 * (SSL Labs' `newAssessmentCoolOff`).
 */
export function createStartGate(
	coolOffMs: number,
	sleep: (ms: number, signal?: AbortSignal) => Promise<void> = n8nSleep,
	now: () => number = Date.now,
): (signal?: AbortSignal) => Promise<void> {
	let lastStart = Number.NEGATIVE_INFINITY;
	let queue: Promise<void> = Promise.resolve();
	return async (signal) => {
		const turn = queue.then(async () => {
			const wait = lastStart + coolOffMs - now();
			if (wait > 0) await sleep(wait, signal);
			lastStart = now();
		});
		queue = turn.catch(() => undefined);
		return await turn;
	};
}

export const DEFAULT_BATCH_CONCURRENCY = 3;
export const MAX_BATCH_CONCURRENCY = 10;
/** Used when `info` does not report a cool-off; matches the reference client. */
export const DEFAULT_COOL_OFF_MS = 1_100;

/** min(requested, free assessment slots), never below 1 or above MAX_BATCH_CONCURRENCY. */
export function batchConcurrency(
	requested: unknown,
	maxAssessments: unknown,
	currentAssessments: unknown,
): number {
	const wanted = Math.min(
		MAX_BATCH_CONCURRENCY,
		Math.max(1, Math.floor(Number(requested) || DEFAULT_BATCH_CONCURRENCY)),
	);
	const max = Number(maxAssessments);
	if (!Number.isFinite(max) || max <= 0) return wanted;
	const free = max - (Number(currentAssessments) || 0);
	return Math.max(1, Math.min(wanted, free));
}
