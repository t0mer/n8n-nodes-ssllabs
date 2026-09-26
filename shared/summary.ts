import { bestGrade, worstGrade } from './grades';
import type { Cert, Host, Summary, SummaryCertificate } from './types';

const DAY_MS = 86_400_000;

/** The docs call cert validity dates "Unix timestamps" but the API usually returns ms; accept both. */
export function toEpochMs(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
	return value < 1e12 ? value * 1000 : value;
}

export function toIso(value: unknown): string | null {
	const ms = toEpochMs(value);
	return ms === null ? null : new Date(ms).toISOString();
}

export function reportUrl(host: string): string {
	return `https://www.ssllabs.com/ssltest/analyze.html?d=${encodeURIComponent(host)}`;
}

/** The leaf certificate: first cert of the first endpoint chain, falling back to the first host cert. */
export function leafCert(host: Host): Cert | null {
	const certs = host.certs ?? [];
	for (const endpoint of host.endpoints ?? []) {
		const leafId = endpoint.details?.certChains?.[0]?.certIds?.[0];
		const match = leafId ? certs.find((c) => c.id === leafId) : undefined;
		if (match) return match;
	}
	return certs[0] ?? null;
}

/** Stable identity of a certificate, for once-per-certificate alerts. */
export function certKey(cert: Cert | null): string | null {
	if (!cert) return null;
	return cert.sha256Hash || cert.sha1Hash || cert.serialNumber || cert.id || null;
}

export function summarizeCert(cert: Cert | null, now: number): SummaryCertificate | null {
	if (!cert) return null;
	const notAfterMs = toEpochMs(cert.notAfter);
	return {
		subject: cert.subject ?? null,
		issuer: cert.issuerSubject ?? null,
		notBefore: toIso(cert.notBefore),
		notAfter: toIso(cert.notAfter),
		daysUntilExpiry: notAfterMs === null ? null : Math.floor((notAfterMs - now) / DAY_MS),
		serialNumber: cert.serialNumber ?? null,
		fingerprint: certKey(cert),
	};
}

/** Maps an SSL Labs Host object to the compact summary item. */
export function toSummary(host: Host, now: number = Date.now()): Summary {
	const endpoints = host.endpoints ?? [];
	const grades = endpoints.map((e) => e.grade);
	const worst = worstGrade(grades);
	return {
		host: host.host,
		status: host.status,
		statusMessage: host.statusMessage ?? null,
		grade: worst,
		worstGrade: worst,
		bestGrade: bestGrade(grades),
		hasWarnings: endpoints.some((e) => e.hasWarnings === true),
		endpoints: endpoints.map((e) => ({
			ipAddress: e.ipAddress ?? null,
			serverName: e.serverName ?? null,
			grade: e.grade ?? null,
			gradeTrustIgnored: e.gradeTrustIgnored ?? null,
			hasWarnings: e.hasWarnings === true,
			isExceptional: e.isExceptional === true,
			statusMessage: e.statusMessage ?? null,
		})),
		certificate: summarizeCert(leafCert(host), now),
		testTime: toIso(host.testTime),
		engineVersion: host.engineVersion ?? null,
		criteriaVersion: host.criteriaVersion ?? null,
		reportUrl: reportUrl(host.host),
	};
}
