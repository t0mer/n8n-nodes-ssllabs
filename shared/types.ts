/** Subset of the SSL Labs API v4 objects that this package reads. Unknown fields pass through untouched. */

export type HostStatus = 'DNS' | 'IN_PROGRESS' | 'READY' | 'ERROR';

export interface Cert {
	id?: string;
	subject?: string;
	issuerSubject?: string;
	serialNumber?: string;
	notBefore?: number;
	notAfter?: number;
	sha1Hash?: string;
	sha256Hash?: string;
	[key: string]: unknown;
}

export interface CertChain {
	id?: string;
	certIds?: string[];
	[key: string]: unknown;
}

export interface Endpoint {
	ipAddress?: string;
	serverName?: string;
	statusMessage?: string;
	grade?: string;
	gradeTrustIgnored?: string;
	hasWarnings?: boolean;
	isExceptional?: boolean;
	progress?: number;
	details?: {
		certChains?: CertChain[];
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export interface Host {
	host: string;
	port?: number;
	protocol?: string;
	status: HostStatus;
	statusMessage?: string;
	startTime?: number;
	testTime?: number;
	engineVersion?: string;
	criteriaVersion?: string;
	endpoints?: Endpoint[];
	certs?: Cert[];
	[key: string]: unknown;
}

export interface Info {
	engineVersion?: string;
	criteriaVersion?: string;
	maxAssessments?: number;
	currentAssessments?: number;
	newAssessmentCoolOff?: number;
	messages?: string[];
	[key: string]: unknown;
}

export interface SummaryEndpoint {
	ipAddress: string | null;
	serverName: string | null;
	grade: string | null;
	gradeTrustIgnored: string | null;
	hasWarnings: boolean;
	isExceptional: boolean;
	statusMessage: string | null;
}

export interface SummaryCertificate {
	subject: string | null;
	issuer: string | null;
	notBefore: string | null;
	notAfter: string | null;
	daysUntilExpiry: number | null;
	serialNumber: string | null;
	fingerprint: string | null;
}

export interface Summary {
	host: string;
	status: HostStatus;
	statusMessage: string | null;
	grade: string | null;
	worstGrade: string | null;
	bestGrade: string | null;
	hasWarnings: boolean;
	endpoints: SummaryEndpoint[];
	certificate: SummaryCertificate | null;
	testTime: string | null;
	engineVersion: string | null;
	criteriaVersion: string | null;
	reportUrl: string;
}
