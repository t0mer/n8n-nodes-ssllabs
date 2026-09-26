import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAnalyzeQs, waitForAssessment } from '../../shared/poll';
import type { SslLabsContext } from '../../shared/transport';
import { fixtures } from '../fixtures';
import { fakeContext, type FakeResponse } from '../helpers';

const ok = (body: unknown): FakeResponse => ({ statusCode: 200, body });
const asCtx = (c: ReturnType<typeof fakeContext>) => c as unknown as SslLabsContext;
const qsOf = (ctx: ReturnType<typeof fakeContext>, call: number) =>
	(
		ctx.helpers.httpRequestWithAuthentication.mock.calls[call] as unknown as [
			string,
			{ qs: Record<string, unknown> },
		]
	)[1].qs;

describe('buildAnalyzeQs', () => {
	const ctx = asCtx(fakeContext());

	it('rejects startNew together with fromCache', () => {
		expect(() =>
			buildAnalyzeQs(ctx, { host: 'a.com', startNew: true, fromCache: true }, true),
		).toThrow(/cannot both be on/);
	});

	it('sends startNew only on the first call', () => {
		expect(buildAnalyzeQs(ctx, { host: 'a.com', startNew: true }, true)).toEqual({
			host: 'a.com',
			all: 'done',
			startNew: 'on',
		});
		expect(buildAnalyzeQs(ctx, { host: 'a.com', startNew: true }, false)).toEqual({
			host: 'a.com',
			all: 'done',
		});
	});

	it('maps cache, publish and mismatch flags', () => {
		expect(
			buildAnalyzeQs(
				ctx,
				{ host: 'a.com', fromCache: true, maxAge: 24, publish: true, ignoreMismatch: true },
				false,
			),
		).toEqual({
			host: 'a.com',
			all: 'done',
			fromCache: 'on',
			maxAge: 24,
			publish: 'on',
			ignoreMismatch: 'on',
		});
	});
});

describe('waitForAssessment (fake timers)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('polls every 5 s during DNS, then every 10 s once IN_PROGRESS', async () => {
		const ctx = fakeContext([
			ok(fixtures.dns()),
			ok(fixtures.dns()),
			ok(fixtures.inProgress()),
			ok(fixtures.inProgress()),
			ok(fixtures.ready()),
		]);
		const calls = ctx.helpers.httpRequestWithAuthentication;
		const done = waitForAssessment(asCtx(ctx), { host: 'example.com', startNew: true });

		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(calls).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveBeenCalledTimes(2); // DNS → wait 5 s
		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls).toHaveBeenCalledTimes(3); // now IN_PROGRESS
		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls).toHaveBeenCalledTimes(3); // 10 s cadence
		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(10_000);

		const host = await done;
		expect(host.status).toBe('READY');
		expect(qsOf(ctx, 0).startNew).toBe('on');
		expect(qsOf(ctx, 1).startNew).toBeUndefined();
	});

	it('returns ERROR hosts without throwing', async () => {
		const ctx = fakeContext([ok(fixtures.dns()), ok(fixtures.error())]);
		const done = waitForAssessment(asCtx(ctx), { host: 'nonexistent.example.com' });
		await vi.advanceTimersByTimeAsync(5_000);
		expect((await done).status).toBe('ERROR');
	});

	it('times out with an actionable message', async () => {
		const ctx = fakeContext(Array.from({ length: 50 }, () => ok(fixtures.inProgress())));
		const done = waitForAssessment(asCtx(ctx), { host: 'example.com' }, { timeoutMs: 60_000 });
		const assertion = expect(done).rejects.toThrow(/did not finish within 1 minutes.*IN_PROGRESS/);
		await vi.advanceTimersByTimeAsync(120_000);
		await assertion;
		expect(ctx.helpers.httpRequestWithAuthentication.mock.calls.length).toBeLessThanOrEqual(7);
	});

	it('stops when the execution is cancelled', async () => {
		const ctx = fakeContext(Array.from({ length: 50 }, () => ok(fixtures.inProgress())));
		const controller = new AbortController();
		const done = waitForAssessment(
			asCtx(ctx),
			{ host: 'example.com' },
			{ abortSignal: controller.signal },
		);
		const assertion = expect(done).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(3_000);
		controller.abort();
		await vi.advanceTimersByTimeAsync(20_000);
		await assertion;
		expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
	});
});
