import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { sslLabsRequest } from '../../../shared/transport';
import type { ResourceModule } from '../shared';

const show = { resource: ['registration'], operation: ['register'] };

const field = (displayName: string, name: string, placeholder: string): INodeProperties => ({
	displayName,
	name,
	type: 'string',
	required: true,
	default: '',
	placeholder,
	displayOptions: { show },
});

const properties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['registration'] } },
		options: [
			{
				name: 'Register',
				value: 'register',
				description:
					'Register an email address with the SSL Labs API v4 (one-time). Free mailbox domains such as Gmail may be rejected.',
				action: 'Register an email address',
			},
		],
		default: 'register',
	},
	field('First Name', 'firstName', 'Jane'),
	field('Last Name', 'lastName', 'Doe'),
	{
		...field('Email', 'email', 'name@example.com'),
		description: 'Use an organization email address',
	},
	field('Organization', 'organization', 'Example Inc.'),
];

export const registration: ResourceModule = {
	properties,
	handlers: {
		async register(ctx, i) {
			const body: IDataObject = {};
			for (const name of ['firstName', 'lastName', 'email', 'organization']) {
				const value = String(ctx.getNodeParameter(name, i, '')).trim();
				if (!value) {
					throw new NodeOperationError(ctx.getNode(), `"${name}" is required to register`, {
						itemIndex: i,
					});
				}
				body[name] = value;
			}
			const { body: response } = await sslLabsRequest<IDataObject>(ctx, {
				path: 'register',
				method: 'POST',
				body,
				authenticate: false,
				retry: false,
				itemIndex: i,
			});
			if (response?.status === 'failure') {
				throw new NodeOperationError(
					ctx.getNode(),
					`SSL Labs registration failed: ${String(response.message ?? 'no reason given')}`,
					{ itemIndex: i },
				);
			}
			return response;
		},
	},
};
