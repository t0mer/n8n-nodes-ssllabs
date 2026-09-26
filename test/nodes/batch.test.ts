import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecuteFunctions } from 'n8n-workflow';
import { SslLabs } from '../../nodes/SslLabs/SslLabs.node';
import { fixtures } from '../fixtures';
import { fakeExecute, type Responder } from '../helpers';

const run = (ctx: ReturnType<typeof fakeExecute>) =>
	new SslLabs().execute.call(ctx as unknown as IExecuteFunctions);

const hosts = ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com', 'e.example.com'];
const items = (extra: Record<string, unknown> = {}) =>
	hosts.map((host) => ({ resource: 'assessment', operation: 'analyze', host, ...extra }));

/** Each host goes DNS → READY; tracks concurrency and start times per host. */
function scenario(info: Record<string, unknown>, failHost?: string) {
	const polls = new Map<string, number>();
	const starts: Array<{ host: string; at: number }> = [];
	const active = new Set<string>();
	let peak = 0;
	const responder: Responder = ({ url, qs }) => {
		if (url.endsWith('/info')) return { statusCode: 200, body: info };
		const host = String(qs?.host);
		if (host === failHost)
			return { statusCode: 400, body: { errors: [{ field: 'host', message: 'bad host' }] } };
		const n = polls.get(host) ?? 0;
		polls.set(host, n + 1);
		if (n === 0) {
			starts.push({ host, at: Date.now() });
			active.add(host);
			peak = Math.max(peak, active.size);
			return { statusCode: 200, body: { ...fixtures.dns(), host } };
		}
		active.delete(host);
		return { statusCode: 200, body: { ...fixtures.ready(), host } };
	};
	return { responder, starts, peak: () => peak };
}

describe('Analyze batching', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('reads info once, caps concurrency at 3 by default, and spaces starts by the cool-off', async () => {
		const s = scenario({ maxAssessments: 25, currentAssessments: 0, newAssessmentCoolOff: 1000 });
		const ctx = fakeExecute({ items: items(), responses: s.responder });
		const done = run(ctx);
		await vi.advanceTimersByTimeAsync(120_000);
		const [out] = await done;

		expect(out.map((o) => o.json.host)).toEqual(hosts);
		expect(out.map((o) => o.pairedItem)).toEqual(hosts.map((_, item) => ({ item })));
		const infoCalls = ctx.helpers.httpRequestWithAuthentication.mock.calls.filter((c) =>
			String((c[1] as { url: string }).url).endsWith('/info'),
		);
		expect(infoCalls).toHaveLength(1);
		expect(s.peak()).toBe(3);
		const gaps = s.starts.slice(1).map((st, i) => st.at - s.starts[i].at);
		expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1100);
	});

	it('limits concurrency to the free slots reported by info', async () => {
		const s = scenario({ maxAssessments: 25, currentAssessments: 24, newAssessmentCoolOff: 1000 });
		const ctx = fakeExecute({
			items: items({ options: { batchConcurrency: 10 } }),
			responses: s.responder,
		});
		const done = run(ctx);
		await vi.advanceTimersByTimeAsync(200_000);
		await done;
		expect(s.peak()).toBe(1);
	});

	it('emits per-item error items with continueOnFail', async () => {
		const s = scenario(
			{ maxAssessments: 25, currentAssessments: 0, newAssessmentCoolOff: 1000 },
			'c.example.com',
		);
		const ctx = fakeExecute({ items: items(), responses: s.responder, continueOnFail: true });
		const done = run(ctx);
		await vi.advanceTimersByTimeAsync(120_000);
		const [out] = await done;
		expect(out).toHaveLength(5);
		expect(out[2]).toEqual({
			json: { error: expect.stringContaining('bad host'), host: 'c.example.com' },
			pairedItem: { item: 2 },
		});
		expect(out[3].json.status).toBe('READY');
	});

	it('fails the batch with the failing item index otherwise', async () => {
		const s = scenario(
			{ maxAssessments: 25, currentAssessments: 0, newAssessmentCoolOff: 1000 },
			'b.example.com',
		);
		const ctx = fakeExecute({ items: items(), responses: s.responder });
		const done = run(ctx);
		const assertion = expect(done).rejects.toMatchObject({ context: { itemIndex: 1 } });
		await vi.advanceTimersByTimeAsync(120_000);
		await assertion;
		expect(s.starts.map((st) => st.host)).not.toContain('e.example.com');
	});

	it('skips info for Get Status batches', async () => {
		const s = scenario({});
		const ctx = fakeExecute({ items: items({ mode: 'getStatus' }), responses: s.responder });
		const [out] = await run(ctx);
		expect(out).toHaveLength(5);
		const urls = ctx.helpers.httpRequestWithAuthentication.mock.calls.map(
			(c) => (c[1] as { url: string }).url,
		);
		expect(urls.some((u) => u.endsWith('/info'))).toBe(false);
	});
});
