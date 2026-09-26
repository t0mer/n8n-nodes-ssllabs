import { describe, expect, it } from 'vitest';
import type { IExecuteFunctions } from 'n8n-workflow';
import { SslLabs } from '../../nodes/SslLabs/SslLabs.node';
import { fixtures } from '../fixtures';
import { fakeExecute, requestOf } from '../helpers';

const run = (ctx: ReturnType<typeof fakeExecute>) =>
	new SslLabs().execute.call(ctx as unknown as IExecuteFunctions);

describe('Endpoint → Get', () => {
	it('calls getEndpointData with host, s and fromCache and returns the raw endpoint', async () => {
		const endpoint = fixtures.ready().endpoints![1];
		const ctx = fakeExecute({
			items: [
				{
					resource: 'endpoint',
					operation: 'get',
					host: 'https://example.com/',
					ipAddress: '[2606:2800:220:1::1]',
				},
			],
			responses: [{ statusCode: 200, body: endpoint }],
		});
		const [out] = await run(ctx);
		expect(out[0]).toEqual({ json: endpoint, pairedItem: { item: 0 } });
		expect(requestOf(ctx, 0).url).toBe('https://api.ssllabs.com/api/v4/getEndpointData');
		expect(requestOf(ctx, 0).qs).toEqual({
			host: 'example.com',
			s: '2606:2800:220:1::1',
			fromCache: 'on',
		});
	});

	it('omits fromCache when Use Cache is off', async () => {
		const ctx = fakeExecute({
			items: [
				{
					resource: 'endpoint',
					operation: 'get',
					host: 'example.com',
					ipAddress: '93.184.216.34',
					useCache: false,
				},
			],
			responses: [{ statusCode: 200, body: {} }],
		});
		await run(ctx);
		expect(requestOf(ctx, 0).qs).toEqual({ host: 'example.com', s: '93.184.216.34' });
	});
});
