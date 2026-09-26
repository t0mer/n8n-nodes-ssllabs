import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class SslLabsApi implements ICredentialType {
	name = 'sslLabsApi';

	displayName = 'SSL Labs API';

	icon: Icon = { light: 'file:sslLabs.svg', dark: 'file:sslLabs.dark.svg' };

	documentationUrl = 'https://github.com/t0mer/n8n-nodes-ssllabs#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Email',
			name: 'email',
			type: 'string',
			placeholder: 'name@example.com',
			default: '',
			required: true,
			description:
				'The email address registered with the SSL Labs API v4. It is sent as the "email" header on every call. The credential test only confirms the API is reachable: an unregistered email fails on the first assessment, so use the Register operation first.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.ssllabs.com/api/v4',
			description:
				'API entry point (HTTPS only). Use https://api.dev.ssllabs.com/api/v4 for the development server (lower limits, no availability guarantee).',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				email: '={{$credentials.email}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL:
				'={{($credentials.baseUrl || "https://api.ssllabs.com/api/v4").trim().replace(/\\/+$/, "")}}',
			url: '/info',
			method: 'GET',
		},
	};
}
