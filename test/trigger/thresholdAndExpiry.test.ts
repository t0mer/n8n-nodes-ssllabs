import { describe, expect, it } from 'vitest';
import type { IPollFunctions } from 'n8n-workflow';
import { SslLabsTrigger } from '../../nodes/SslLabsTrigger/SslLabsTrigger.node';
import type { Host } from '../../shared/types';
import { fixtures } from '../fixtures';
import { fakePoll } from '../helpers';

const poll = (ctx: ReturnType<typeof fakePoll>) =>
	new SslLabsTrigger().poll.call(ctx as unknown as IPollFunctions);

const DAY = 86_400_000;

function host(grade: string, cert?: { daysLeft: number; fingerprint: string }): Host {
	const h = fixtures.ready();
	for (const e of h.endpoints ?? []) e.grade = grade;
	if (cert) {
		const leaf = h.certs!.find((c) => c.id === 'leaf1')!;
		leaf.notAfter = Date.now() + cert.daysLeft * DAY + 3_600_000;
		leaf.sha256Hash = cert.fingerprint;
	}
	return h;
}

/** Runs consecutive polls sharing state; returns the emitted json items of each poll. */
async function sequence(params: Record<string, unknown>, hosts: Host[]) {
	const staticData = {};
	const results = [];
	for (const h of hosts) {
		const out = await poll(
			fakePoll({ params, staticData, responses: [{ statusCode: 200, body: h }] }),
		);
		results.push(out ? out[0].map((i) => i.json) : []);
	}
	return results;
}

describe('SSL Labs Trigger — grade below threshold', () => {
	const params = {
		hosts: ['example.com'],
		event: 'gradeBelowThreshold',
		thresholdGrade: 'A',
		maxAge: 24,
	};

	it('fires once on crossing and re-arms when the grade recovers', async () => {
		const out = await sequence(params, [host('A'), host('B'), host('C'), host('A'), host('B')]);
		expect(out.map((o) => o.length)).toEqual([0, 1, 0, 0, 1]);
		expect(out[1][0]).toMatchObject({
			event: 'gradeBelowThreshold',
			grade: 'B',
			previousGrade: 'A',
			thresholdGrade: 'A',
		});
	});

	it('treats T and M as below F', async () => {
		const out = await sequence({ ...params, thresholdGrade: 'F' }, [host('F'), host('T')]);
		expect(out[1]).toHaveLength(1);
		expect(out[1][0]).toMatchObject({ grade: 'T' });
	});

	it('does not fire on the baseline even when already below', async () => {
		const out = await sequence(params, [host('C'), host('C')]);
		expect(out).toEqual([[], []]);
	});
});

describe('SSL Labs Trigger — certificate expiring', () => {
	const params = {
		hosts: ['example.com'],
		event: 'certificateExpiring',
		daysBeforeExpiry: 21,
		maxAge: 24,
	};

	it('fires once per certificate and re-arms on a new certificate', async () => {
		const out = await sequence(params, [
			host('A', { daysLeft: 40, fingerprint: 'cert-1' }),
			host('A', { daysLeft: 20, fingerprint: 'cert-1' }),
			host('A', { daysLeft: 19, fingerprint: 'cert-1' }),
			host('A', { daysLeft: 5, fingerprint: 'cert-2' }),
			host('A', { daysLeft: 4, fingerprint: 'cert-2' }),
		]);
		expect(out.map((o) => o.length)).toEqual([0, 1, 0, 1, 0]);
		expect(out[1][0]).toMatchObject({
			event: 'certificateExpiring',
			certificate: { daysUntilExpiry: 20, fingerprint: 'cert-1' },
		});
		expect(out[3][0]).toMatchObject({
			certificate: { fingerprint: 'cert-2', daysUntilExpiry: 5 },
			previousCertificate: { fingerprint: 'cert-1' },
		});
	});

	it('does not alert for a renewed certificate that is not expiring', async () => {
		const out = await sequence(params, [
			host('A', { daysLeft: 40, fingerprint: 'cert-1' }),
			host('A', { daysLeft: 90, fingerprint: 'cert-2' }),
		]);
		expect(out).toEqual([[], []]);
	});

	it('works with the expiring fixture (second-based timestamps)', async () => {
		const expiring = fixtures.expiring();
		const out = await sequence(params, [host('A', { daysLeft: 60, fingerprint: 'old' }), expiring]);
		expect(out[1]).toHaveLength(1);
		expect(out[1][0]).toMatchObject({
			certificate: { fingerprint: 'ee-expiring', serialNumber: '0badc0de' },
		});
	});
});
