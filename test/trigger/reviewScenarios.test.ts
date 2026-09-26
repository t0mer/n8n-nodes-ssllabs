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

const host_ = (grade: string, name: string) => host(grade, { name });

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

	it.each([429, 503, 529])('stops the poll on %i without recording an error', async (status) => {
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
		expect(staticData).toMatchObject({ hosts: { 'a.example.com': { error: null, grade: null } } });
	});

	it('skips only the failing host on a 500 or network error, and never starves the others', async () => {
		const staticData = {};
		const hosts = ['a.example.com', 'x.example.com', 'b.example.com'];
		const params = { ...base, hosts, event: 'gradeChanged', options: { emitErrors: true } };
		for (let round = 0; round < 3; round++) {
			const seen: string[] = [];
			const ctx = fakePoll({
				params,
				staticData,
				responses: ({ qs }) => {
					const host = String(qs?.host);
					seen.push(host);
					if (host === 'x.example.com') return { statusCode: 500 };
					if (host === 'b.example.com' && round === 1) {
						throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
					}
					return ok(host_('A', host));
				},
			});
			expect(await poll(ctx)).toBeNull();
			expect([...seen].sort()).toEqual([...hosts].sort());
		}
		expect(staticData).toMatchObject({ hosts: { 'x.example.com': { error: null } } });
	});

	it.each([
		[
			'a non-https base URL',
			{ credentials: { email: 'a@b.c', baseUrl: 'http://api.ssllabs.com/api/v4' } },
			/https/,
		],
		['a 404', { status: 404 }, /HTTP 404/],
		['a 403', { status: 403 }, /HTTP 403/],
	])('fails the poll on %s instead of hiding it', async (_label, setup, message) => {
		const ctx = fakePoll({
			params: { ...base, event: 'gradeChanged' },
			responses: [{ statusCode: (setup as { status?: number }).status ?? 200, body: 'Not Found' }],
			credentials: (setup as { credentials?: Record<string, unknown> }).credentials,
		});
		await expect(poll(ctx)).rejects.toThrow(message);
	});

	it('does not fire Grade Changed or threshold alerts off an ungraded first result', async () => {
		const noGrade = host('A');
		for (const e of noGrade.endpoints ?? []) delete e.grade;
		const gc = await sequence([
			{ params: { ...base, event: 'gradeChanged' }, body: noGrade },
			{ params: { ...base, event: 'gradeChanged' }, body: host('B') },
		]);
		expect(gc).toEqual([[], []]);
		const th = { ...base, event: 'gradeBelowThreshold', thresholdGrade: 'A' };
		const out = await sequence([
			{ params: th, body: noGrade },
			{ params: th, body: host('F') },
			{ params: th, body: host('F') },
		]);
		expect(out).toEqual([[], [], []]);
	});

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
			responses: ({ url }) => {
				if (url.endsWith('/info')) return { statusCode: 200, body: { newAssessmentCoolOff: 2000 } };
				calls.push(Date.now() - t0);
				return ok(fixtures.dns());
			},
		});
		const done = poll(ctx);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await done).toBeNull();
		expect(calls).toHaveLength(2);
		expect(calls[1] - calls[0]).toBe(2_100); // newAssessmentCoolOff from /info + 100 ms
	});

	it('does not wait for hosts that were already pending, or after the last host', async () => {
		vi.useFakeTimers();
		const staticData = {};
		const params = { ...base, hosts: ['a.example.com', 'b.example.com'], event: 'gradeChanged' };
		const infoCalls: number[] = [];
		const responses: Responder = ({ url }) => {
			if (url.endsWith('/info')) {
				infoCalls.push(1);
				return { statusCode: 200, body: { newAssessmentCoolOff: 1000 } };
			}
			return ok(fixtures.inProgress());
		};
		const first = poll(fakePoll({ params, staticData, responses }));
		await vi.advanceTimersByTimeAsync(5_000);
		await first;
		expect(infoCalls).toHaveLength(1);

		// Both hosts are pending now: the second poll must not wait or read /info at all.
		const t0 = Date.now();
		await poll(fakePoll({ params, staticData, responses }));
		expect(Date.now() - t0).toBe(0);
		expect(infoCalls).toHaveLength(1);
	});
});
