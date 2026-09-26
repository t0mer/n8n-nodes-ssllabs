import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IPollFunctions } from 'n8n-workflow';
import { SslLabsTrigger } from '../../nodes/SslLabsTrigger/SslLabsTrigger.node';
import type { Host } from '../../shared/types';
import { fixtures } from '../fixtures';
import { fakePoll, type FakeResponse, type Responder } from '../helpers';

const poll = (ctx: ReturnType<typeof fakePoll>) =>
	new SslLabsTrigger().poll.call(ctx as unknown as IPollFunctions);
const DAY = 86_400_000;
const ok = (body: Host): FakeResponse => ({ statusCode: 200, body });

function host(
	grade: string,
	opts: { daysLeft?: number; fingerprint?: string; name?: string } = {},
): Host {
	const h = fixtures.ready();
	h.host = opts.name ?? 'example.com';
	for (const e of h.endpoints ?? []) e.grade = grade;
	const leaf = h.certs!.find((c) => c.id === 'leaf1')!;
	leaf.notAfter = Date.now() + (opts.daysLeft ?? 90) * DAY + 3_600_000;
	leaf.sha256Hash = opts.fingerprint ?? 'cert-1';
	return h;
}

async function sequence(steps: Array<{ params: Record<string, unknown>; body: Host }>) {
	const staticData = {};
	const out = [];
	for (const step of steps) {
		const r = await poll(fakePoll({ params: step.params, staticData, responses: [ok(step.body)] }));
		out.push(r ? r[0].map((i) => i.json) : []);
	}
	return out;
}

const base = { hosts: ['example.com'], maxAge: 24 };
const expiry = { ...base, event: 'certificateExpiring', daysBeforeExpiry: 21 };

describe('trigger review scenarios', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('alerts on the second poll for a certificate already expiring at the baseline, once', async () => {
		const out = await sequence([
			{ params: expiry, body: host('A', { daysLeft: 5 }) },
			{ params: expiry, body: host('A', { daysLeft: 5 }) },
			{ params: expiry, body: host('A', { daysLeft: 4 }) },
		]);
		expect(out.map((o) => o.length)).toEqual([0, 1, 0]);
		expect(out[1][0]).toMatchObject({
			event: 'certificateExpiring',
			certificate: { daysUntilExpiry: 5 },
		});
	});

	it('alerts after switching from Grade Changed to Certificate Expiring', async () => {
		const gradeChanged = { ...base, event: 'gradeChanged' };
		const out = await sequence([
			{ params: gradeChanged, body: host('A', { daysLeft: 10 }) },
			{ params: gradeChanged, body: host('A', { daysLeft: 9 }) },
			{ params: expiry, body: host('A', { daysLeft: 8 }) },
		]);
		expect(out.map((o) => o.length)).toEqual([0, 0, 1]);
	});

	it('re-baselines silently when the threshold changes, then fires on the next crossing', async () => {
		const a = { ...base, event: 'gradeBelowThreshold', thresholdGrade: 'A' };
		const b = { ...a, thresholdGrade: 'B' };
		const out = await sequence([
			{ params: a, body: host('A') },
			{ params: b, body: host('C') },
			{ params: b, body: host('B') },
			{ params: b, body: host('M') },
		]);
		expect(out.map((o) => o.length)).toEqual([0, 0, 0, 1]);
		expect(out[3][0]).toMatchObject({ grade: 'M', thresholdGrade: 'B' });
	});

	it('recomputes days until expiry from notAfter when a later result has no certificate', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-09-26T00:00:00Z'));
		const staticData = {};
		await poll(
			fakePoll({ params: expiry, staticData, responses: [ok(host('A', { daysLeft: 30 }))] }),
		);
		const noCert = host('A');
		delete noCert.certs;
		for (const e of noCert.endpoints ?? []) delete e.details;
		vi.setSystemTime(new Date('2026-10-06T00:00:00Z')); // 10 days later → 20 days left
		const out = await poll(fakePoll({ params: expiry, staticData, responses: [ok(noCert)] }));
		expect(out?.[0][0].json).toMatchObject({
			event: 'certificateExpiring',
			certificate: { daysUntilExpiry: 20 },
		});
	});

	it('keys state by the configured host even when the API echoes a different form', async () => {
		const params = { ...base, event: 'gradeChanged' };
		const out = await sequence([
			{ params, body: host('A', { name: 'EXAMPLE.COM.' }) },
			{ params, body: host('B', { name: 'EXAMPLE.COM.' }) },
		]);
		expect(out[1]).toHaveLength(1);
		expect(out[1][0]).toMatchObject({ host: 'example.com', previousGrade: 'A' });
	});

	it.each([429, 503, 500])(
		'skips the rest of the poll on %i without recording an error',
		async (status) => {
			const staticData = {};
			const seen: string[] = [];
			const responder: Responder = ({ qs }) => {
				seen.push(String(qs?.host));
				return { statusCode: status };
			};
			const ctx = fakePoll({
				params: {
					...base,
					hosts: ['a.example.com', 'b.example.com'],
					event: 'gradeChanged',
					options: { emitErrors: true },
				},
				staticData,
				responses: responder,
			});
			expect(await poll(ctx)).toBeNull();
			expect(seen).toEqual(['a.example.com']);
			expect(staticData).toEqual({ stateVersion: 1, hosts: {} });
		},
	);

	it('records a host-specific 400 as an error', async () => {
		const staticData = {};
		await poll(
			fakePoll({
				params: { ...base, event: 'gradeChanged' },
				staticData,
				responses: [ok(host('A'))],
			}),
		);
		const out = await poll(
			fakePoll({
				params: { ...base, event: 'gradeChanged', options: { emitErrors: true } },
				staticData,
				responses: [
					{ statusCode: 400, body: { errors: [{ field: 'host', message: 'bad host' }] } },
				],
			}),
		);
		expect(out?.[0][0].json).toMatchObject({
			event: 'assessmentError',
			statusMessage: expect.stringContaining('bad host'),
		});
	});

	it('waits the cool-off after a call that starts a new assessment', async () => {
		vi.useFakeTimers();
		const calls: number[] = [];
		const t0 = Date.now();
		const ctx = fakePoll({
			params: { ...base, hosts: ['a.example.com', 'b.example.com'], event: 'gradeChanged' },
			responses: () => {
				calls.push(Date.now() - t0);
				return ok(fixtures.dns());
			},
		});
		const done = poll(ctx);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await done).toBeNull();
		expect(calls).toHaveLength(2);
		expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(1_100);
	});
});
