import { describe, expect, it } from 'vitest';
import type { IPollFunctions } from 'n8n-workflow';
import { SslLabsTrigger } from '../../nodes/SslLabsTrigger/SslLabsTrigger.node';
import type { Host } from '../../shared/types';
import { fixtures } from '../fixtures';
import { fakePoll, type FakeResponse, type Responder } from '../helpers';

const poll = (ctx: ReturnType<typeof fakePoll>) =>
	new SslLabsTrigger().poll.call(ctx as unknown as IPollFunctions);

const ok = (body: Host): FakeResponse => ({ statusCode: 200, body });
const withGrade = (grade: string, host = 'example.com'): Host => {
	const h = fixtures.ready();
	h.host = host;
	for (const e of h.endpoints ?? []) e.grade = grade;
	return h;
};

describe('SSL Labs Trigger — grade changed', () => {
	const params = { hosts: ['https://Example.com/'], event: 'gradeChanged', maxAge: 24 };

	it('establishes a baseline on the first run, then fires on a grade change only', async () => {
		const staticData = {};
		const first = fakePoll({ params, staticData, responses: [ok(withGrade('A'))] });
		expect(await poll(first)).toBeNull();
		expect(staticData).toMatchObject({ stateVersion: 1, hosts: { 'example.com': { grade: 'A' } } });

		const same = fakePoll({ params, staticData, responses: [ok(withGrade('A'))] });
		expect(await poll(same)).toBeNull();

		const changed = fakePoll({ params, staticData, responses: [ok(withGrade('B'))] });
		const out = await poll(changed);
		expect(out?.[0]).toHaveLength(1);
		expect(out?.[0][0].json).toMatchObject({
			event: 'gradeChanged',
			host: 'example.com',
			grade: 'B',
			previousGrade: 'A',
			reportUrl: 'https://www.ssllabs.com/ssltest/analyze.html?d=example.com',
		});

		const qs = (changed.helpers.httpRequestWithAuthentication.mock.calls[0][1] as { qs: unknown })
			.qs;
		expect(qs).toEqual({ host: 'example.com', all: 'done', fromCache: 'on', maxAge: 24 });
	});

	it('marks in-progress hosts pending without emitting, and resolves them later', async () => {
		const staticData = {};
		await poll(fakePoll({ params, staticData, responses: [ok(withGrade('A'))] }));
		expect(
			await poll(fakePoll({ params, staticData, responses: [ok(fixtures.inProgress())] })),
		).toBeNull();
		expect(staticData).toMatchObject({ hosts: { 'example.com': { pending: true, grade: 'A' } } });
		const out = await poll(fakePoll({ params, staticData, responses: [ok(withGrade('A-'))] }));
		expect(out?.[0][0].json).toMatchObject({ grade: 'A-', previousGrade: 'A' });
		expect(staticData).toMatchObject({ hosts: { 'example.com': { pending: false } } });
	});

	it('does not throw and skips remaining hosts on 429/503/529', async () => {
		const staticData = {};
		const hosts = ['a.example.com', 'b.example.com', 'c.example.com'];
		const seen: string[] = [];
		const responder: Responder = ({ qs }) => {
			const host = String(qs?.host);
			seen.push(host);
			return host === 'b.example.com' ? { statusCode: 529 } : ok(withGrade('A', host));
		};
		const ctx = fakePoll({ params: { ...params, hosts }, staticData, responses: responder });
		expect(await poll(ctx)).toBeNull();
		expect(seen).toEqual(['a.example.com', 'b.example.com']);
		// Retries are disabled in the trigger: one call per host.
		expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledTimes(2);

		// Next poll starts with the hosts that were not checked.
		seen.length = 0;
		await poll(
			fakePoll({
				params: { ...params, hosts },
				staticData,
				responses: ({ qs }) => {
					seen.push(String(qs?.host));
					return ok(withGrade('A', String(qs?.host)));
				},
			}),
		);
		expect(seen).toEqual(['b.example.com', 'c.example.com', 'a.example.com']);
	});

	it('throws when the email is not registered', async () => {
		const ctx = fakePoll({ params, responses: [{ statusCode: 441 }] });
		await expect(poll(ctx)).rejects.toThrow(/not registered/);
	});

	it('stores ERROR results and emits them only when Emit Errors is on', async () => {
		const staticData = {};
		await poll(fakePoll({ params, staticData, responses: [ok(withGrade('A'))] }));
		const quiet = await poll(
			fakePoll({
				params,
				staticData,
				responses: [ok({ ...fixtures.error(), host: 'example.com' })],
			}),
		);
		expect(quiet).toBeNull();
		expect(staticData).toMatchObject({
			hosts: { 'example.com': { error: 'Unable to resolve domain name', grade: 'A' } },
		});

		const loud = {};
		await poll(fakePoll({ params, staticData: loud, responses: [ok(withGrade('A'))] }));
		const out = await poll(
			fakePoll({
				params: { ...params, options: { emitErrors: true } },
				staticData: loud,
				responses: [ok({ ...fixtures.error(), host: 'example.com' })],
			}),
		);
		expect(out?.[0][0].json).toMatchObject({ event: 'assessmentError', status: 'ERROR' });
	});

	it('returns current summaries in manual mode without touching state', async () => {
		const staticData = {};
		const out = await poll(
			fakePoll({ params, staticData, mode: 'manual', responses: [ok(withGrade('A'))] }),
		);
		expect(out?.[0][0].json).toMatchObject({ event: 'test', host: 'example.com', grade: 'A' });
		expect(staticData).toEqual({});
	});

	it('stops early when the poll budget is used up', async () => {
		const hosts = ['a.example.com', 'b.example.com'];
		let calls = 0;
		const ctx = fakePoll({
			params: { ...params, hosts },
			pollBudgetMs: 0,
			responses: () => {
				calls++;
				return ok(withGrade('A'));
			},
		});
		await poll(ctx);
		expect(calls).toBe(1);
	});

	it('resets unknown state versions to a fresh baseline', async () => {
		const staticData: Record<string, unknown> = {
			stateVersion: 0,
			hosts: { 'example.com': { grade: 'F' } },
		};
		expect(
			await poll(fakePoll({ params, staticData, responses: [ok(withGrade('A'))] })),
		).toBeNull();
		expect(staticData).toMatchObject({ stateVersion: 1, hosts: { 'example.com': { grade: 'A' } } });
	});
});
