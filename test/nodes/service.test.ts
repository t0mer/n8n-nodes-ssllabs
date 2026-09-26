import { describe, expect, it } from 'vitest';
import type { IExecuteFunctions } from 'n8n-workflow';
import { SslLabs } from '../../nodes/SslLabs/SslLabs.node';
import { fakeExecute, requestOf } from '../helpers';

const run = (ctx: ReturnType<typeof fakeExecute>) =>
	new SslLabs().execute.call(ctx as unknown as IExecuteFunctions);

describe('Service resource', () => {
	it('gets info', async () => {
		const info = { engineVersion: '2.3.1', maxAssessments: 25, currentAssessments: 0 };
		const ctx = fakeExecute({
			items: [{ resource: 'service', operation: 'getInfo' }],
			responses: [{ statusCode: 200, body: info }],
		});
		const [out] = await run(ctx);
		expect(out).toEqual([{ json: info, pairedItem: { item: 0 } }]);
		expect(requestOf(ctx, 0).url).toBe('https://api.ssllabs.com/api/v4/info');
	});

	it('gets status codes', async () => {
		const codes = {
			statusDetails: {
				TESTING_PROTOCOL_INTOLERANCE_399: 'Testing Protocol Intolerance (TLS 1.152)',
			},
		};
		const ctx = fakeExecute({
			items: [{ resource: 'service', operation: 'getStatusCodes' }],
			responses: [{ statusCode: 200, body: codes }],
		});
		const [out] = await run(ctx);
		expect(out[0].json).toEqual(codes);
		expect(requestOf(ctx, 0).url).toMatch(/\/getStatusCodes$/);
	});

	it('gets raw root certificates for a trust store', async () => {
		const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
		const ctx = fakeExecute({
			items: [{ resource: 'service', operation: 'getRootCertificates', trustStore: '4' }],
			responses: [{ statusCode: 200, body: pem }],
		});
		const [out] = await run(ctx);
		expect(out[0].json).toEqual({ trustStoreId: 4, trustStore: 'Java', certificates: pem });
		expect(requestOf(ctx, 0).qs).toEqual({ trustStore: '4' });
	});

	it('turns failures into error items with continueOnFail', async () => {
		const ctx = fakeExecute({
			items: [{ resource: 'service', operation: 'getInfo' }],
			responses: [{ statusCode: 400, body: { errors: [{ message: 'bad' }] } }],
			continueOnFail: true,
		});
		const [out] = await run(ctx);
		expect(out[0].json.error).toContain('bad');
		expect(out[0].pairedItem).toEqual({ item: 0 });
	});

	it('throws with the item index otherwise', async () => {
		const ctx = fakeExecute({
			items: [{ resource: 'service', operation: 'getInfo' }],
			responses: [{ statusCode: 400, body: { errors: [{ message: 'bad' }] } }],
		});
		await expect(run(ctx)).rejects.toMatchObject({ context: { itemIndex: 0 } });
	});
});
