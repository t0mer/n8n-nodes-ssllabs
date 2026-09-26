import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, sleep as n8nSleep } from 'n8n-workflow';

export const DEFAULT_BASE_URL = 'https://api.ssllabs.com/api/v4';
export const CREDENTIAL_TYPE = 'sslLabsApi';

export const UNREGISTERED_EMAIL_MESSAGE =
	'Email is not registered with SSL Labs v4 — use the Register operation first';

export type SslLabsContext = IExecuteFunctions | IPollFunctions;

export interface SslLabsRequest {
	/** Path relative to the base URL, e.g. "analyze". */
	path: string;
	method?: IHttpRequestMethods;
	qs?: IDataObject;
	body?: IDataObject;
	/** Send the credential's email header. False only for "register". */
	authenticate?: boolean;
	abortSignal?: AbortSignal;
	itemIndex?: number;
	/** Retry policy for 429/500/503/529. `false` disables retries (e.g. in the polling trigger). */
	retry?: Partial<RetryPolicy> | false;
}

export interface RetryPolicy {
	/** Retries after a 429 (too many assessments). */
	rateLimitRetries: number;
	rateLimitWaitMs: number;
	/** Retries after a 503 (maintenance) or 529 (overloaded). */
	unavailableRetries: number;
	unavailableWaitMs: number;
	/** Retries after a 500. */
	serverErrorRetries: number;
	serverErrorWaitMs: number;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Epoch ms after which no retry wait may end; the last error is thrown instead. */
	deadline?: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	rateLimitRetries: 3,
	rateLimitWaitMs: 15_000,
	unavailableRetries: 2,
	unavailableWaitMs: 60_000,
	serverErrorRetries: 1,
	serverErrorWaitMs: 5_000,
	sleep: n8nSleep,
};

/** HTTP statuses that mean "SSL Labs is busy": back off rather than fail the input. */
export const BUSY_STATUSES = [429, 503, 529];

export function isBusyError(error: unknown): boolean {
	return (
		error instanceof NodeApiError && BUSY_STATUSES.includes(Number(error.httpCode ?? Number.NaN))
	);
}

function retryPlan(policy: RetryPolicy, statusCode: number): { retries: number; waitMs: number } {
	if (statusCode === 429)
		return { retries: policy.rateLimitRetries, waitMs: policy.rateLimitWaitMs };
	if (statusCode === 503 || statusCode === 529) {
		return { retries: policy.unavailableRetries, waitMs: policy.unavailableWaitMs };
	}
	if (statusCode === 500)
		return { retries: policy.serverErrorRetries, waitMs: policy.serverErrorWaitMs };
	return { retries: 0, waitMs: 0 };
}

export interface SslLabsResponse<T> {
	body: T;
	headers: IDataObject;
}

export function normalizeBaseUrl(url: unknown): string {
	const value = typeof url === 'string' ? url.trim() : '';
	return (value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

async function resolveBaseUrl(ctx: SslLabsContext, required: boolean): Promise<string> {
	if (required) {
		const credentials = await ctx.getCredentials(CREDENTIAL_TYPE);
		return normalizeBaseUrl(credentials.baseUrl);
	}
	try {
		const credentials = await ctx.getCredentials(CREDENTIAL_TYPE);
		return normalizeBaseUrl(credentials.baseUrl);
	} catch {
		return DEFAULT_BASE_URL;
	}
}

function parseBody(body: unknown): unknown {
	if (typeof body !== 'string') return body;
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}

interface ApiErrorEntry {
	field?: string;
	message?: string;
}

function apiErrors(body: unknown): ApiErrorEntry[] {
	if (body && typeof body === 'object' && Array.isArray((body as IDataObject).errors)) {
		return (body as { errors: ApiErrorEntry[] }).errors;
	}
	return [];
}

function describeApiErrors(body: unknown): string {
	const errors = apiErrors(body);
	if (errors.length) {
		return errors
			.map((e) => (e.field ? `${e.field}: ${e.message ?? ''}` : (e.message ?? '')))
			.join('; ');
	}
	if (body && typeof body === 'object' && typeof (body as IDataObject).message === 'string') {
		return (body as IDataObject).message as string;
	}
	return typeof body === 'string' ? body.slice(0, 500) : '';
}

export function isUnregisteredEmail(statusCode: number, body: unknown): boolean {
	if (statusCode === 441) return true;
	if (statusCode !== 400) return false;
	return apiErrors(body).some(
		(e) => e.field === 'email' || /not\s+(yet\s+)?register/i.test(e.message ?? ''),
	);
}

const STATUS_MESSAGES: Record<number, string> = {
	400: 'SSL Labs rejected the request parameters',
	429: 'SSL Labs rate limit reached (too many concurrent or new assessments). Lower the batch concurrency or try again later',
	500: 'SSL Labs internal server error. Try again later',
	503: 'SSL Labs is unavailable (maintenance). Try again in 15–30 minutes',
	529: 'SSL Labs is overloaded. Try again in 15–30 minutes',
};

/** Builds the NodeApiError for a non-2xx response. */
export function toApiError(
	ctx: SslLabsContext,
	statusCode: number,
	body: unknown,
	itemIndex?: number,
	authenticated = true,
): NodeApiError {
	const detail = describeApiErrors(body);
	const errorResponse = (
		body && typeof body === 'object' ? body : { message: detail || String(statusCode) }
	) as JsonObject;
	// Only authenticated calls send the email header; on /register an email error is a validation error.
	if (authenticated && isUnregisteredEmail(statusCode, body)) {
		return new NodeApiError(ctx.getNode(), errorResponse, {
			message: UNREGISTERED_EMAIL_MESSAGE,
			description: detail || undefined,
			httpCode: String(statusCode),
			itemIndex,
		});
	}
	const base = STATUS_MESSAGES[statusCode] ?? `SSL Labs request failed with HTTP ${statusCode}`;
	return new NodeApiError(ctx.getNode(), errorResponse, {
		message: detail ? `${base}: ${detail}` : base,
		description: detail || undefined,
		httpCode: String(statusCode),
		itemIndex,
	});
}

/**
 * Performs an SSL Labs API call, retrying 429/500/503/529 a bounded number of times,
 * and maps any final non-2xx status to NodeApiError.
 */
export async function sslLabsRequest<T = unknown>(
	ctx: SslLabsContext,
	request: SslLabsRequest,
): Promise<SslLabsResponse<T>> {
	const authenticate = request.authenticate ?? true;
	const baseUrl = await resolveBaseUrl(ctx, authenticate);
	const policy: RetryPolicy | null =
		request.retry === false ? null : { ...DEFAULT_RETRY_POLICY, ...request.retry };
	const options: IHttpRequestOptions = {
		method: request.method ?? 'GET',
		url: `${baseUrl}/${request.path.replace(/^\/+/, '')}`,
		qs: request.qs,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		abortSignal: request.abortSignal,
	};
	if (request.body) {
		options.body = request.body;
		options.json = true;
	}

	for (let attempt = 0; ; attempt++) {
		const response = (
			authenticate
				? await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_TYPE, options)
				: await ctx.helpers.httpRequest(options)
		) as { statusCode: number; body: unknown; headers?: IDataObject };

		const body = parseBody(response.body);
		if (response.statusCode >= 200 && response.statusCode < 300) {
			return { body: body as T, headers: response.headers ?? {} };
		}
		const plan = policy ? retryPlan(policy, response.statusCode) : { retries: 0, waitMs: 0 };
		if (!policy || attempt >= plan.retries) {
			throw toApiError(ctx, response.statusCode, body, request.itemIndex, authenticate);
		}
		// Linear backoff with jitter, as the API docs recommend randomising waits.
		const waitMs = Math.round(plan.waitMs * (attempt + 1) * (0.75 + Math.random() * 0.5));
		if (policy.deadline !== undefined && Date.now() + waitMs > policy.deadline) {
			throw toApiError(ctx, response.statusCode, body, request.itemIndex, authenticate);
		}
		await policy.sleep(waitMs, request.abortSignal);
	}
}
