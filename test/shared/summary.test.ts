import { describe, expect, it } from 'vitest';
import { certKey, leafCert, toEpochMs, toSummary } from '../../shared/summary';
import { fixtures, NOW } from '../fixtures';

describe('toSummary', () => {
	it('summarizes a READY multi-endpoint host with mixed grades', () => {
		const s = toSummary(fixtures.ready(), NOW);
		expect(s.host).toBe('example.com');
		expect(s.status).toBe('READY');
		expect(s.grade).toBe('B');
		expect(s.worstGrade).toBe('B');
		expect(s.bestGrade).toBe('A+');
		expect(s.hasWarnings).toBe(true);
		expect(s.endpoints).toHaveLength(3);
		expect(s.endpoints[2]).toEqual({
			ipAddress: '93.184.216.35',
			serverName: 'edge.example.com',
			grade: 'A+',
			gradeTrustIgnored: 'A+',
			hasWarnings: false,
			isExceptional: true,
			statusMessage: 'Ready',
		});
		expect(s.testTime).toBe(new Date(NOW - 10000).toISOString());
		expect(s.engineVersion).toBe('2.3.1');
		expect(s.criteriaVersion).toBe('2009q');
		expect(s.reportUrl).toBe('https://www.ssllabs.com/ssltest/analyze.html?d=example.com');
	});

	it('picks the leaf certificate via the endpoint chain, not certs[0]', () => {
		const s = toSummary(fixtures.ready(), NOW);
		expect(s.certificate).toMatchObject({
			subject: 'CN=example.com',
			issuer: "CN=R11, O=Let's Encrypt, C=US",
			daysUntilExpiry: 61,
			serialNumber: '04a1b2c3',
			fingerprint: 'bbleaf1',
		});
		expect(s.certificate?.notAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('ignores failed endpoints when grading', () => {
		const s = toSummary(fixtures.failedEndpoint(), NOW);
		expect(s.grade).toBe('A-');
		expect(s.endpoints[1].grade).toBeNull();
		expect(s.endpoints[1].statusMessage).toBe('Unable to connect to the server');
	});

	it('accepts second-based certificate timestamps', () => {
		const s = toSummary(fixtures.expiring(), NOW);
		expect(s.certificate?.daysUntilExpiry).toBe(10);
		expect(s.certificate?.notAfter).toBe(new Date(NOW + 10 * 86400000 + 3600000).toISOString());
	});

	it('handles hosts with missing fields (DNS, ERROR, IN_PROGRESS)', () => {
		for (const host of [fixtures.dns(), fixtures.error(), fixtures.inProgress()]) {
			const s = toSummary(host, NOW);
			expect(s.grade).toBeNull();
			expect(s.bestGrade).toBeNull();
			expect(s.certificate).toBeNull();
			expect(s.hasWarnings).toBe(false);
		}
		const err = toSummary(fixtures.error(), NOW);
		expect(err.statusMessage).toBe('Unable to resolve domain name');
		expect(toSummary(fixtures.dns(), NOW).testTime).toBeNull();
	});
});

describe('helpers', () => {
	it('converts epochs', () => {
		expect(toEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
		expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
		expect(toEpochMs(undefined)).toBeNull();
		expect(toEpochMs(0)).toBeNull();
	});

	it('derives a cert key with fallbacks', () => {
		expect(certKey({ sha256Hash: 'a', sha1Hash: 'b' })).toBe('a');
		expect(certKey({ sha1Hash: 'b', serialNumber: 'c' })).toBe('b');
		expect(certKey({ serialNumber: 'c', id: 'd' })).toBe('c');
		expect(certKey({})).toBeNull();
		expect(certKey(null)).toBeNull();
	});

	it('falls back to the first host cert when no chain references exist', () => {
		const host = fixtures.ready();
		for (const e of host.endpoints ?? []) delete e.details;
		expect(leafCert(host)?.id).toBe('inter1');
	});
});
