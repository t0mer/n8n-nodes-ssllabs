import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { sslLabsRequest } from '../../../shared/transport';
import type { ResourceModule } from '../shared';

const show = { resource: ['service'] };

export const TRUST_STORES: Record<string, string> = {
	'1': 'Mozilla',
	'2': 'Apple MacOS',
	'3': 'Android',
	'4': 'Java',
	'5': 'Windows',
};

const properties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show },
		options: [
			{
				name: 'Get Info',
				value: 'getInfo',
				description: 'Check availability, engine version and your assessment limits',
				action: 'Get service info',
			},
			{
				name: 'Get Root Certificates',
				value: 'getRootCertificates',
				description: 'Get the raw root certificates of a trust store',
				action: 'Get root certificates',
			},
			{
				name: 'Get Status Codes',
				value: 'getStatusCodes',
				description: 'Get the translations of assessment status codes',
				action: 'Get status codes',
			},
		],
		default: 'getInfo',
	},
	{
		displayName: 'Trust Store',
		name: 'trustStore',
		type: 'options',
		displayOptions: { show: { ...show, operation: ['getRootCertificates'] } },
		options: Object.entries(TRUST_STORES)
			.map(([value, name]) => ({ name, value }))
			.sort((a, b) => a.name.localeCompare(b.name)),
		default: '1',
		description: 'The trust store whose root certificates to return',
	},
];

export const service: ResourceModule = {
	properties,
	handlers: {
		async getInfo(ctx, i) {
			const { body } = await sslLabsRequest<IDataObject>(ctx, { path: 'info', itemIndex: i });
			return body;
		},
		async getStatusCodes(ctx, i) {
			const { body } = await sslLabsRequest<IDataObject>(ctx, {
				path: 'getStatusCodes',
				itemIndex: i,
			});
			return body;
		},
		async getRootCertificates(ctx, i) {
			const trustStore = String(ctx.getNodeParameter('trustStore', i, '1'));
			const { body } = await sslLabsRequest<unknown>(ctx, {
				path: 'getRootCertsRaw',
				qs: { trustStore },
				itemIndex: i,
			});
			const meta = {
				trustStoreId: Number(trustStore),
				trustStore: TRUST_STORES[trustStore] ?? trustStore,
			};
			return body && typeof body === 'object'
				? { ...meta, ...(body as IDataObject) }
				: { ...meta, certificates: typeof body === 'string' ? body : String(body ?? '') };
		},
	},
};
