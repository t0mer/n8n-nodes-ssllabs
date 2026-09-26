import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { service } from './resources/service';
import type { ResourceModule } from './shared';

/*
 * Programmatic rather than declarative: assessments need multi-call polling with
 * cadence changes, timeouts, retries and batch-level concurrency control.
 */

const resources: Record<string, ResourceModule> = { service };

function toNodeError(ctx: IExecuteFunctions, error: Error, itemIndex: number) {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) {
		error.context.itemIndex = itemIndex;
		return error;
	}
	return new NodeOperationError(ctx.getNode(), error, { itemIndex });
}

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
		credentials: [{ name: 'sslLabsApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [{ name: 'Service', value: 'service' }],
				default: 'service',
			},
			...Object.values(resources).flatMap((r) => r.properties),
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			let failure: Error | undefined;
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const handler = resources[resource]?.handlers[operation];
				if (!handler) {
					throw new NodeOperationError(this.getNode(), `Unsupported operation "${operation}"`, {
						itemIndex: i,
					});
				}
				const result = await handler(this, i);
				for (const json of Array.isArray(result) ? result : [result]) {
					returnData.push({ json, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				failure = error as Error;
			}
			if (failure) throw toNodeError(this, failure, i);
		}

		return [returnData];
	}
}
