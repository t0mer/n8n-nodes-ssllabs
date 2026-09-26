import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { assessment } from './resources/assessment';
import { registration } from './resources/registration';
import { service } from './resources/service';
import { errorItem, toNodeError, type ResourceModule } from './shared';

/*
 * Programmatic rather than declarative: assessments need multi-call polling with
 * cadence changes, timeouts, retries and batch-level concurrency control.
 */

const resources: Record<string, ResourceModule> = { assessment, registration, service };

export class SslLabs implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SSL Labs',
		name: 'sslLabs',
		icon: { light: 'file:sslLabs.svg', dark: 'file:sslLabs.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Run SSL/TLS server assessments with the Qualys SSL Labs API v4',
		defaults: { name: 'SSL Labs' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'sslLabsApi',
				required: true,
				displayOptions: { hide: { resource: ['registration'] } },
			},
			{
				// Optional here: registration works without a credential, but uses its base URL if set.
				name: 'sslLabsApi',
				required: false,
				displayOptions: { show: { resource: ['registration'] } },
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Assessment', value: 'assessment' },
					{ name: 'Registration', value: 'registration' },
					{ name: 'Service', value: 'service' },
				],
				default: 'assessment',
			},
			...Object.values(resources).flatMap((r) => r.properties),
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		// Resource and operation are not expressions (noDataExpression), so item 0 decides for all.
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const module = resources[resource];
		const batch = module?.batchHandlers?.[operation];
		if (batch) return [await batch(this)];

		const handler = module?.handlers[operation];
		if (!handler) {
			throw new NodeOperationError(
				this.getNode(),
				`Unsupported operation "${resource}: ${operation}"`,
			);
		}

		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			let failure: Error | undefined;
			try {
				const result = await handler(this, i);
				for (const json of Array.isArray(result) ? result : [result]) {
					returnData.push({ json, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push(errorItem(this, error as Error, i));
					continue;
				}
				failure = error as Error;
			}
			if (failure) throw toNodeError(this, failure, i);
		}

		return [returnData];
	}
}
