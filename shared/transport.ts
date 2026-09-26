import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

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
		return errors.map((e) => (e.field ? `${e.field}: ${e.message ?? ''}` : (e.message ?? ''))).join('; ');
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
): NodeApiError {
	const detail = describeApiErrors(body);
	const errorResponse = (
		body && typeof body === 'object' ? body : { message: detail || String(statusCode) }
	) as JsonObject;
	if (isUnregisteredEmail(statusCode, body)) {
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

/** Performs one SSL Labs API call and maps non-2xx statuses to NodeApiError. */
export async function sslLabsRequest<T = unknown>(
	ctx: SslLabsContext,
	request: SslLabsRequest,
): Promise<SslLabsResponse<T>> {
	const authenticate = request.authenticate ?? true;
	const baseUrl = await resolveBaseUrl(ctx, authenticate);
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

	const response = (
		authenticate
			? await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_TYPE, options)
			: await ctx.helpers.httpRequest(options)
	) as { statusCode: number; body: unknown; headers?: IDataObject };

	const body = parseBody(response.body);
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw toApiError(ctx, response.statusCode, body, request.itemIndex);
	}
	return { body: body as T, headers: response.headers ?? {} };
}
