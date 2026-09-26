import type {
	IDataObject,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, sleep } from 'n8n-workflow';
import { GRADE_ORDER, isGrade } from '../../shared/grades';
import { DEFAULT_COOL_OFF_MS } from '../../shared/batch';
import { normalizeHost } from '../../shared/host';
import { analyze, isFinished } from '../../shared/poll';
import { toSummary } from '../../shared/summary';
import { isBusyError, UNREGISTERED_EMAIL_MESSAGE } from '../../shared/transport';
import {
	applyResult,
	loadState,
	markPending,
	type EventConfig,
	type EventItem,
	type TriggerEvent,
} from './state';

/** Stop starting new host checks once this share of the poll budget is used. */
const BUDGET_SHARE = 0.8;

const properties: INodeProperties[] = [
	{
		displayName: 'Hosts',
		name: 'hosts',
		type: 'string',
		typeOptions: { multipleValues: true, multipleValueButtonText: 'Add Host' },
		default: [],
		placeholder: 'example.com',
		description: 'Hostnames to watch. Only watch hosts you own or are authorized to test.',
	},
	{
		displayName: 'Event',
		name: 'event',
		type: 'options',
		options: [
			{
				name: 'Certificate Expiring',
				value: 'certificateExpiring',
				description: 'Fires once per certificate when it expires within the given number of days',
			},
			{
				name: 'Grade Below Threshold',
				value: 'gradeBelowThreshold',
				description:
					'Fires once when the grade drops below the threshold; re-arms when the grade recovers',
			},
			{
				name: 'Grade Changed',
				value: 'gradeChanged',
				description: "Fires when a host's grade differs from the last seen grade",
			},
		],
		default: 'gradeChanged',
	},
	{
		displayName: 'Threshold Grade',
		name: 'thresholdGrade',
		type: 'options',
		options: GRADE_ORDER.map((grade) => ({ name: grade, value: grade })),
		default: 'A',
		description:
			'Fire when the grade is worse than this. T (trust issues) and M (name mismatch) rank below F.',
		displayOptions: { show: { event: ['gradeBelowThreshold'] } },
	},
	{
		displayName: 'Days Before Expiry',
		name: 'daysBeforeExpiry',
		type: 'number',
		default: 21,
		typeOptions: { minValue: 0 },
		description: 'Fire when the certificate expires within this many days',
		displayOptions: { show: { event: ['certificateExpiring'] } },
	},
	{
		displayName: 'Max Result Age (Hours)',
		name: 'maxAge',
		type: 'number',
		default: 24,
		typeOptions: { minValue: 1 },
		description:
			'Cached SSL Labs results up to this old are reused; a host is re-assessed at most this often',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			{
				displayName: 'Emit Errors',
				name: 'emitErrors',
				type: 'boolean',
				default: false,
				description: 'Whether to emit an item when an assessment ends in ERROR',
			},
		],
	},
];

function readHosts(ctx: IPollFunctions): string[] {
	const raw = ctx.getNodeParameter('hosts', []) as string[] | string;
	const values = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => String(v).split(/[\s,]+/));
	const hosts = values.filter((v) => v.trim() !== '').map((v) => normalizeHost(v, ctx.getNode()));
	return [...new Set(hosts)];
}

/** 4xx responses other than the busy/unregistered ones: problems specific to the request. */
function isClientError(error: unknown): boolean {
	if (!(error instanceof NodeApiError) || isBusyError(error)) return false;
	const status = Number(error.httpCode);
	return status >= 400 && status < 500;
}

function isUnregistered(error: unknown): boolean {
	return error instanceof NodeApiError && error.message === UNREGISTERED_EMAIL_MESSAGE;
}

export class SslLabsTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SSL Labs Trigger',
		name: 'sslLabsTrigger',
		icon: { light: 'file:sslLabs.svg', dark: 'file:sslLabs.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Watch SSL Labs grades and certificates of your hosts',
		defaults: { name: 'SSL Labs Trigger' },
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'sslLabsApi', required: true }],
		properties,
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const hosts = readHosts(this);
		const maxAge = this.getNodeParameter('maxAge', 24) as number;
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const threshold = this.getNodeParameter('thresholdGrade', 'A');
		const config: EventConfig = {
			event: this.getNodeParameter('event', 'gradeChanged') as TriggerEvent,
			emitErrors: options.emitErrors === true,
			thresholdGrade: isGrade(threshold) ? threshold : 'A',
			daysBeforeExpiry: this.getNodeParameter('daysBeforeExpiry', 21) as number,
		};
		const analyzeOnce = async (host: string) =>
			await analyze(this, { host, fromCache: true, maxAge, all: 'done' }, true, { retry: false });

		if (this.getMode() === 'manual') {
			// "Fetch Test Event": show the current summary of each host, without touching state.
			const items: INodeExecutionData[] = [];
			for (const host of hosts) {
				items.push({
					json: { ...toSummary({ ...(await analyzeOnce(host)), host }), event: 'test' },
				});
			}
			return items.length ? [items] : null;
		}

		const state = loadState(this.getWorkflowStaticData('node'));
		const started = Date.now();
		const budgetMs =
			typeof this.getPollBudgetMs === 'function'
				? this.getPollBudgetMs()
				: Number.POSITIVE_INFINITY;
		// Least recently checked first, so hosts skipped by a busy or slow poll go first next time.
		const ordered = [...hosts].sort(
			(a, b) => (state.hosts[a]?.lastCheckedAt ?? 0) - (state.hosts[b]?.lastCheckedAt ?? 0),
		);

		const emitted: EventItem[] = [];
		let fatal: NodeApiError | undefined;
		let checked = 0;
		for (const host of ordered) {
			// Always check at least one host, then stay within the poll budget.
			if (checked++ > 0 && Date.now() - started >= budgetMs * BUDGET_SHARE) break;
			let result;
			try {
				result = await analyzeOnce(host);
			} catch (error) {
				if (isUnregistered(error)) {
					fatal = error as NodeApiError;
					break;
				}
				// Busy (429/503/529), server or network trouble: try the rest next poll.
				if (!isClientError(error)) break;
				// A 4xx for this host is a real, host-specific problem: record it.
				const summary = toSummary({
					host,
					status: 'ERROR',
					statusMessage: (error as Error).message,
				});
				emitted.push(...applyResult(state, summary, config, Date.now()));
				continue;
			}
			// Key state by the configured host, whatever form the API echoes back.
			const summary = toSummary({ ...result, host });
			if (!isFinished(result)) {
				const wasPending = state.hosts[host]?.pending === true;
				markPending(state, host, Date.now());
				// This call probably started a new assessment: respect the cool-off before the next.
				if (!wasPending && host !== ordered[ordered.length - 1]) {
					await sleep(DEFAULT_COOL_OFF_MS);
				}
				continue;
			}
			emitted.push(...applyResult(state, summary, config, Date.now()));
		}

		if (fatal) throw fatal;

		// Forget hosts that were removed from the list.
		for (const host of Object.keys(state.hosts)) {
			if (!hosts.includes(host)) delete state.hosts[host];
		}

		return emitted.length ? [emitted.map((e) => ({ json: e as unknown as IDataObject }))] : null;
	}
}
