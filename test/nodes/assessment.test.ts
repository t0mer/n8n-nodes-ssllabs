import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecuteFunctions } from 'n8n-workflow';
import { SslLabs } from '../../nodes/SslLabs/SslLabs.node';
import { fixtures } from '../fixtures';
import { fakeExecute, requestOf, type FakeResponse } from '../helpers';

const run = (ctx: ReturnType<typeof fakeExecute>) =>
	new SslLabs().execute.call(ctx as unknown as IExecuteFunctions);
const ok = (body: unknown): FakeResponse => ({ statusCode: 200, body });
const item = (extra: Record<string, unknown> = {}) => ({
	resource: 'assessment',
	operation: 'analyze',
	host: 'https://Example.com/login',
	...extra,
});

describe('Assessment → Analyze', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('waits for the result and returns a summary (default mode, cache on)', async () => {
		const ctx = fakeExecute({
			items: [item()],
			responses: [ok(fixtures.dns()), ok(fixtures.inProgress()), ok(fixtures.ready())],
		});
		const done = run(ctx);
		await vi.advanceTimersByTimeAsync(20_000);
		const [out] = await done;
		expect(out).toHaveLength(1);
		expect(out[0].pairedItem).toEqual({ item: 0 });
		expect(out[0].json).toMatchObject({
			host: 'example.com',
			status: 'READY',
			grade: 'B',
			bestGrade: 'A+',
		});
		expect(requestOf(ctx, 0).qs).toEqual({
			host: 'example.com',
			all: 'done',
			fromCache: 'on',
			maxAge: 24,
		});
	});

	it('Start Only makes one call with startNew when forced', async () => {
		const ctx = fakeExecute({
			items: [item({ mode: 'startOnly', useCache: false, forceNewScan: true })],
			responses: [ok(fixtures.dns())],
		});
		const [out] = await run(ctx);
		expect(out[0].json).toMatchObject({ status: 'DNS', grade: null });
		expect(requestOf(ctx, 0).qs).toEqual({ host: 'example.com', all: 'done', startNew: 'on' });
		expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
	});

	it('Get Status never sends startNew', async () => {
		const ctx = fakeExecute({
			items: [item({ mode: 'getStatus', useCache: false, forceNewScan: true })],
			responses: [ok(fixtures.inProgress())],
		});
		const [out] = await run(ctx);
		expect(out[0].json.status).toBe('IN_PROGRESS');
		expect(requestOf(ctx, 0).qs).toEqual({ host: 'example.com', all: 'done' });
	});

	it('returns the raw host plus reportUrl for Full detail', async () => {
		const ready = fixtures.ready();
		const ctx = fakeExecute({
			items: [
				item({
					mode: 'getStatus',
					options: { detailLevel: 'full', publish: true, ignoreMismatch: true },
				}),
			],
			responses: [ok(ready)],
		});
		const [out] = await run(ctx);
		expect(out[0].json).toEqual({
			...ready,
			reportUrl: 'https://www.ssllabs.com/ssltest/analyze.html?d=example.com',
		});
		expect(requestOf(ctx, 0).qs).toMatchObject({ publish: 'on', ignoreMismatch: 'on' });
	});

	it('fails on an ERROR assessment by default', async () => {
		const ctx = fakeExecute({
			items: [item({ mode: 'getStatus' })],
			responses: [ok(fixtures.error())],
		});
		await expect(run(ctx)).rejects.toThrow(
			'Assessment of example.com failed: Unable to resolve domain name',
		);
	});

	it('emits the ERROR host when Fail on Assessment Error is off', async () => {
		const ctx = fakeExecute({
			items: [item({ mode: 'getStatus', options: { failOnError: false } })],
			responses: [ok(fixtures.error())],
		});
		const [out] = await run(ctx);
		expect(out[0].json).toMatchObject({
			status: 'ERROR',
			statusMessage: 'Unable to resolve domain name',
		});
	});

	it('emits { error, host } items with continueOnFail', async () => {
		const ctx = fakeExecute({
			items: [item({ host: 'not a host' })],
			continueOnFail: true,
		});
		const [out] = await run(ctx);
		expect(out[0]).toEqual({
			json: { error: '"not a host" is not a valid hostname', host: 'not a host' },
			pairedItem: { item: 0 },
		});
	});

	it('honors the configured timeout', async () => {
		const ctx = fakeExecute({
			items: [item({ options: { timeout: 1 } })],
			responses: Array.from({ length: 20 }, () => ok(fixtures.inProgress())),
		});
		const done = run(ctx);
		const assertion = expect(done).rejects.toThrow(/did not finish within 1 minutes/);
		await vi.advanceTimersByTimeAsync(120_000);
		await assertion;
	});
});
