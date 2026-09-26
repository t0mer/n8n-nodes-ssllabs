import type { IDataObject } from 'n8n-workflow';
import { NodeOperationError, sleep as n8nSleep } from 'n8n-workflow';
import { sslLabsRequest, type RetryPolicy, type SslLabsContext } from './transport';
import type { Host } from './types';

export interface AnalyzeParams {
	host: string;
	/** Start a fresh assessment. Mutually exclusive with fromCache. */
	startNew?: boolean;
	/** Accept a cached report (optionally no older than maxAge hours). */
	fromCache?: boolean;
	maxAge?: number;
	publish?: boolean;
	ignoreMismatch?: boolean;
	all?: 'on' | 'done';
}

export interface AnalyzeCallOptions {
	abortSignal?: AbortSignal;
	itemIndex?: number;
	retry?: Partial<RetryPolicy> | false;
}

/**
 * Builds the analyze query string. `startNew` is only sent on the first call: repeating it
 * while polling restarts the assessment in a loop, per the API docs.
 */
export function buildAnalyzeQs(
	ctx: SslLabsContext,
	params: AnalyzeParams,
	firstCall: boolean,
	itemIndex?: number,
): IDataObject {
	if (params.startNew && params.fromCache) {
		throw new NodeOperationError(
			ctx.getNode(),
			'"Force New Scan" and "Use Cache" cannot both be on',
			{
				itemIndex,
				description: 'SSL Labs rejects startNew together with fromCache. Turn one of them off.',
			},
		);
	}
	const qs: IDataObject = { host: params.host, all: params.all ?? 'done' };
	if (params.publish) qs.publish = 'on';
	if (params.ignoreMismatch) qs.ignoreMismatch = 'on';
	if (params.fromCache) {
		qs.fromCache = 'on';
		if (params.maxAge !== undefined && params.maxAge > 0) qs.maxAge = Math.ceil(params.maxAge);
	} else if (params.startNew && firstCall) {
		qs.startNew = 'on';
	}
	return qs;
}

/** One analyze call. */
export async function analyze(
	ctx: SslLabsContext,
	params: AnalyzeParams,
	firstCall: boolean,
	options: AnalyzeCallOptions = {},
): Promise<Host> {
	const { body } = await sslLabsRequest<Host>(ctx, {
		path: 'analyze',
		qs: buildAnalyzeQs(ctx, params, firstCall, options.itemIndex),
		abortSignal: options.abortSignal,
		itemIndex: options.itemIndex,
		retry: options.retry,
	});
	return body;
}

export function isFinished(host: Host): boolean {
	return host.status === 'READY' || host.status === 'ERROR';
}

export interface WaitOptions extends AnalyzeCallOptions {
	/** Poll interval while the status is DNS (default 5 s). */
	initialIntervalMs?: number;
	/** Poll interval once the status is IN_PROGRESS (default 10 s). */
	intervalMs?: number;
	/** Give up after this long (default 15 min). */
	timeoutMs?: number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	now?: () => number;
}

/** Starts (or reuses) an assessment and polls until it is READY or ERROR, or the timeout passes. */
export async function waitForAssessment(
	ctx: SslLabsContext,
	params: AnalyzeParams,
	options: WaitOptions = {},
): Promise<Host> {
	const initialIntervalMs = options.initialIntervalMs ?? 5_000;
	const intervalMs = options.intervalMs ?? 10_000;
	const timeoutMs = options.timeoutMs ?? 15 * 60_000;
	const wait = options.sleep ?? n8nSleep;
	const now = options.now ?? Date.now;
	const deadline = now() + timeoutMs;

	let host = await analyze(ctx, params, true, options);
	while (!isFinished(host)) {
		const delay = host.status === 'IN_PROGRESS' ? intervalMs : initialIntervalMs;
		if (now() + delay > deadline) {
			throw new NodeOperationError(
				ctx.getNode(),
				`Assessment of ${params.host} did not finish within ${Math.round(timeoutMs / 60_000)} minutes (last status: ${host.status})`,
				{
					itemIndex: options.itemIndex,
					description:
						'Assessments usually take 1–5 minutes per IP address. Increase "Timeout (Minutes)", or use the "Start Only" mode and read the result later with "Get Status".',
				},
			);
		}
		if (options.abortSignal?.aborted) {
			throw new NodeOperationError(ctx.getNode(), 'Execution was cancelled', {
				itemIndex: options.itemIndex,
			});
		}
		await wait(delay, options.abortSignal);
		host = await analyze(ctx, params, false, options);
	}
	return host;
}
