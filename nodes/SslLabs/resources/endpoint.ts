import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { normalizeHost } from '../../../shared/host';
import { sslLabsRequest } from '../../../shared/transport';
import type { ResourceModule } from '../shared';

const show = { resource: ['endpoint'], operation: ['get'] };

const properties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['endpoint'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				description:
					'Get full details of one endpoint (IP address) of an assessed host. Never starts a new assessment.',
				action: 'Get endpoint details',
			},
		],
		default: 'get',
	},
	{
		displayName: 'Host',
		name: 'host',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'example.com',
		displayOptions: { show },
	},
	{
		displayName: 'IP Address',
		name: 'ipAddress',
		type: 'string',
		required: true,
		default: '',
		placeholder: '93.184.216.34',
		description: 'Endpoint IP address, as listed in the endpoints of an Analyze result',
		displayOptions: { show },
	},
	{
		displayName: 'Use Cache',
		name: 'useCache',
		type: 'boolean',
		default: true,
		description: 'Whether to return the cached endpoint data',
		displayOptions: { show },
	},
];

export const endpoint: ResourceModule = {
	properties,
	handlers: {
		async get(ctx, i) {
			const host = normalizeHost(ctx.getNodeParameter('host', i), ctx.getNode(), i);
			const ipAddress = String(ctx.getNodeParameter('ipAddress', i, ''))
				.trim()
				.replace(/^\[|\]$/g, '');
			if (!ipAddress) {
				throw new NodeOperationError(ctx.getNode(), 'IP Address is required', { itemIndex: i });
			}
			const qs: IDataObject = { host, s: ipAddress };
			if (ctx.getNodeParameter('useCache', i, true) as boolean) qs.fromCache = 'on';
			const { body } = await sslLabsRequest<IDataObject>(ctx, {
				path: 'getEndpointData',
				qs,
				abortSignal: ctx.getExecutionCancelSignal(),
				itemIndex: i,
			});
			return body;
		},
	},
};
