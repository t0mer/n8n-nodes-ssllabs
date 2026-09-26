import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	batchConcurrency,
	createStartGate,
	DEFAULT_BATCH_CONCURRENCY,
	DEFAULT_COOL_OFF_MS,
	MAX_BATCH_CONCURRENCY,
	runPool,
} from '../../../shared/batch';
import { normalizeHost } from '../../../shared/host';
import { analyze, waitForAssessment, type AnalyzeParams } from '../../../shared/poll';
import { reportUrl, toSummary } from '../../../shared/summary';
import { sslLabsRequest } from '../../../shared/transport';
import type { Host, Info } from '../../../shared/types';
import { errorItem, toNodeError, type ResourceModule } from '../shared';

const show = { resource: ['assessment'], operation: ['analyze'] };

const properties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['assessment'] } },
		options: [
			{
				name: 'Analyze',
				value: 'analyze',
				description: 'Assess the SSL/TLS configuration of a host',
				action: 'Analyze a host',
			},
		],
		default: 'analyze',
	},
	{
		displayName: 'Host',
		name: 'host',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'example.com',
		description:
			'Hostname to assess. A pasted URL is reduced to its hostname. Only assess hosts you own or are authorized to test.',
		displayOptions: { show },
	},
	{
		displayName: 'Mode',
		name: 'mode',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show },
		options: [
			{
				name: 'Get Status',
				value: 'getStatus',
				description:
					'Make a single call and return the current state. SSL Labs starts an assessment if none exists (or the cache is too old).',
			},
			{
				name: 'Start Only',
				value: 'startOnly',
				description: 'Start the assessment and return right away with its status',
			},
			{
				name: 'Wait for Result',
				value: 'waitForResult',
				description:
					'Start (or reuse a cached) assessment and wait until it finishes. Can take several minutes.',
			},
		],
		default: 'waitForResult',
	},
	{
		displayName: 'Use Cache',
		name: 'useCache',
		type: 'boolean',
		default: true,
		description: 'Whether to accept a cached report instead of running a new assessment',
		displayOptions: { show },
	},
	{
		displayName: 'Max Cache Age (Hours)',
		name: 'maxAge',
		type: 'number',
		default: 24,
		typeOptions: { minValue: 0 },
		description: 'Only accept cached reports up to this old. 0 accepts any cached report.',
		displayOptions: { show: { ...show, useCache: [true] } },
	},
	{
		displayName: 'Force New Scan',
		name: 'forceNewScan',
		type: 'boolean',
		default: false,
		description: 'Whether to start a fresh assessment even if one was run recently',
		displayOptions: { show: { ...show, useCache: [false], mode: ['startOnly', 'waitForResult'] } },
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show },
		options: [
			{
				displayName: 'Batch Concurrency',
				name: 'batchConcurrency',
				type: 'number',
				default: DEFAULT_BATCH_CONCURRENCY,
				typeOptions: { minValue: 1, maxValue: MAX_BATCH_CONCURRENCY },
				description:
					'Maximum assessments to run at once when there are several input items. Also capped by the free slots SSL Labs reports.',
			},
			{
				displayName: 'Detail Level',
				name: 'detailLevel',
				type: 'options',
				options: [
					{ name: 'Full', value: 'full', description: 'The raw SSL Labs host object' },
					{ name: 'Summary', value: 'summary', description: 'Grades, endpoints and certificate' },
				],
				default: 'summary',
			},
			{
				displayName: 'Fail on Assessment Error',
				name: 'failOnError',
				type: 'boolean',
				default: true,
				description:
					'Whether to fail when the assessment ends in ERROR. When off, the ERROR result is returned as an item.',
			},
			{
				displayName: 'Ignore Certificate Mismatch',
				name: 'ignoreMismatch',
				type: 'boolean',
				default: false,
				description:
					'Whether to continue the assessment when the certificate does not match the hostname',
			},
			{
				displayName: 'Initial Poll Interval (Seconds)',
				name: 'initialPollInterval',
				type: 'number',
				default: 5,
				typeOptions: { minValue: 5 },
				description: 'How often to check while the assessment is resolving DNS',
				displayOptions: { show: { '/mode': ['waitForResult'] } },
			},
			{
				displayName: 'Poll Interval (Seconds)',
				name: 'pollInterval',
				type: 'number',
				default: 10,
				typeOptions: { minValue: 5 },
				description: 'How often to check once the assessment is in progress',
				displayOptions: { show: { '/mode': ['waitForResult'] } },
			},
			{
				displayName: 'Publish Results',
				name: 'publish',
				type: 'boolean',
				default: false,
				description:
					'Whether to publish the results. Warning: published results appear on the public SSL Labs boards.',
			},
			{
				displayName: 'Timeout (Minutes)',
				name: 'timeout',
				type: 'number',
				default: 15,
				typeOptions: { minValue: 1 },
				description: 'Stop waiting after this long. Use Start Only mode for very long batches.',
				displayOptions: { show: { '/mode': ['waitForResult'] } },
			},
		],
	},
];

export interface AnalyzeHooks {
	abortSignal?: AbortSignal;
	/** Awaited before any call that may start a new assessment. */
	beforeStart?: () => Promise<void>;
}

export type AnalyzeMode = 'waitForResult' | 'startOnly' | 'getStatus';

export function readMode(ctx: IExecuteFunctions, i: number): AnalyzeMode {
	return ctx.getNodeParameter('mode', i, 'waitForResult') as AnalyzeMode;
}

/** Runs Assessment → Analyze for input item `i`. */
export async function analyzeItem(
	ctx: IExecuteFunctions,
	i: number,
	hooks: AnalyzeHooks = {},
): Promise<IDataObject> {
	const host = normalizeHost(ctx.getNodeParameter('host', i), ctx.getNode(), i);
	const mode = readMode(ctx, i);
	const useCache = ctx.getNodeParameter('useCache', i, true) as boolean;
	const options = ctx.getNodeParameter('options', i, {}) as IDataObject;

	const params: AnalyzeParams = {
		host,
		fromCache: useCache,
		maxAge: useCache ? (ctx.getNodeParameter('maxAge', i, 24) as number) : undefined,
		startNew:
			!useCache &&
			mode !== 'getStatus' &&
			(ctx.getNodeParameter('forceNewScan', i, false) as boolean),
		publish: options.publish === true,
		ignoreMismatch: options.ignoreMismatch === true,
		all: 'done',
	};
	const callOptions = { abortSignal: hooks.abortSignal, itemIndex: i };

	let result: Host;
	if (mode === 'waitForResult') {
		result = await waitForAssessment(ctx, params, {
			...callOptions,
			beforeStart: hooks.beforeStart,
			initialIntervalMs: Number(options.initialPollInterval ?? 5) * 1000,
			intervalMs: Number(options.pollInterval ?? 10) * 1000,
			timeoutMs: Number(options.timeout ?? 15) * 60_000,
		});
	} else {
		await hooks.beforeStart?.();
		result = await analyze(ctx, params, true, callOptions);
	}

	if (result.status === 'ERROR' && options.failOnError !== false) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Assessment of ${host} failed: ${result.statusMessage ?? 'unknown error'}`,
			{
				itemIndex: i,
				description:
					'Turn off "Fail on Assessment Error" to receive the ERROR result as an item instead.',
			},
		);
	}

	return options.detailLevel === 'full'
		? { ...(result as IDataObject), reportUrl: reportUrl(result.host ?? host) }
		: (toSummary(result) as unknown as IDataObject);
}

/**
 * Runs Analyze for all input items with bounded concurrency. Before starting assessments for
 * several items it reads `info` once, caps concurrency at the free assessment slots, and spaces
 * starts by `newAssessmentCoolOff`.
 */
export async function executeAnalyze(ctx: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const count = ctx.getInputData().length;
	const cancelSignal = ctx.getExecutionCancelSignal();
	const continueOnFail = ctx.continueOnFail();
	const requested = (ctx.getNodeParameter('options', 0, {}) as IDataObject).batchConcurrency;

	let concurrency = 1;
	let gate: ((signal?: AbortSignal) => Promise<void>) | undefined;
	// Every mode may start assessments (even Get Status, when nothing is cached), so all
	// batches respect the free slots and the cool-off.
	if (count > 1) {
		const { body: info } = await sslLabsRequest<Info>(ctx, {
			path: 'info',
			abortSignal: cancelSignal,
		});
		concurrency = batchConcurrency(requested, info.maxAssessments, info.currentAssessments);
		const coolOff = Number(info.newAssessmentCoolOff);
		gate = createStartGate(coolOff > 0 ? coolOff + 100 : DEFAULT_COOL_OFF_MS);
	}

	const { results, firstError } = await runPool(
		count,
		concurrency,
		async (i, signal) =>
			await analyzeItem(ctx, i, {
				abortSignal: signal,
				beforeStart: gate ? async () => await gate(signal) : undefined,
			}),
		{ signal: cancelSignal, stopOnError: !continueOnFail },
	);
	if (firstError) throw toNodeError(ctx, firstError.error, firstError.index);

	return results.map((result, i) => {
		if (result?.ok) return { json: result.value, pairedItem: { item: i } };
		const error = result?.error ?? new NodeOperationError(ctx.getNode(), 'Execution was cancelled');
		if (!continueOnFail) throw toNodeError(ctx, error, i);
		return errorItem(ctx, error, i);
	});
}

export const assessment: ResourceModule = {
	properties,
	handlers: {},
	batchHandlers: { analyze: executeAnalyze },
};
