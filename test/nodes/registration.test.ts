import { describe, expect, it } from 'vitest';
import type { IExecuteFunctions } from 'n8n-workflow';
import { SslLabs } from '../../nodes/SslLabs/SslLabs.node';
import { fakeExecute } from '../helpers';

const run = (ctx: ReturnType<typeof fakeExecute>) =>
	new SslLabs().execute.call(ctx as unknown as IExecuteFunctions);

const params = {
	resource: 'registration',
	operation: 'register',
	firstName: ' Jane ',
	lastName: 'Doe',
	email: 'jane@example.com',
	organization: 'Example Inc.',
};

describe('Registration resource', () => {
	it('POSTs JSON to /register without a credential', async () => {
		const ctx = fakeExecute({
			items: [params],
			responses: [{ statusCode: 200, body: { status: 'success', message: 'User registered' } }],
			credentials: null,
		});
		const [out] = await run(ctx);
		expect(out[0].json).toEqual({ status: 'success', message: 'User registered' });
		const [options] = ctx.helpers.httpRequest.mock.calls[0] as unknown as [
			{ url: string; method: string; body: unknown; headers?: unknown },
		];
		expect(options.url).toBe('https://api.ssllabs.com/api/v4/register');
		expect(options.method).toBe('POST');
		expect(options.body).toEqual({
			firstName: 'Jane',
			lastName: 'Doe',
			email: 'jane@example.com',
			organization: 'Example Inc.',
		});
	});

	it('uses the base URL of an attached credential', async () => {
		const ctx = fakeExecute({
			items: [params],
			responses: [{ statusCode: 200, body: { status: 'success', message: 'ok' } }],
			credentials: { email: 'x@example.com', baseUrl: 'https://api.dev.ssllabs.com/api/v4' },
		});
		await run(ctx);
		const [options] = ctx.helpers.httpRequest.mock.calls[0] as unknown as [{ url: string }];
		expect(options.url).toBe('https://api.dev.ssllabs.com/api/v4/register');
	});

	it('surfaces a "failure" status message verbatim', async () => {
		const ctx = fakeExecute({
			items: [params],
			responses: [
				{ statusCode: 200, body: { status: 'failure', message: 'Problem while registering user' } },
			],
			credentials: null,
		});
		await expect(run(ctx)).rejects.toThrow(
			'SSL Labs registration failed: Problem while registering user',
		);
	});

	it('surfaces API validation errors verbatim', async () => {
		const ctx = fakeExecute({
			items: [params],
			responses: [
				{
					statusCode: 400,
					body: { errors: [{ field: 'email', message: 'Free email services are not allowed' }] },
				},
			],
			credentials: null,
		});
		await expect(run(ctx)).rejects.toThrow(/Free email services are not allowed/);
	});
});
