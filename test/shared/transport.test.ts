import { describe, expect, it } from 'vitest';
import { NodeApiError } from 'n8n-workflow';
import {
	DEFAULT_BASE_URL,
	sslLabsRequest,
	UNREGISTERED_EMAIL_MESSAGE,
	type SslLabsContext,
} from '../../shared/transport';
import { fakeContext } from '../helpers';

const asCtx = (c: ReturnType<typeof fakeContext>) => c as unknown as SslLabsContext;

describe('sslLabsRequest', () => {
	it('uses the credential base URL (trailing slash stripped) and the authenticated helper', async () => {
		const ctx = fakeContext([{ statusCode: 200, body: { engineVersion: '2.3.1' } }]);
		const res = await sslLabsRequest(asCtx(ctx), { path: 'info' });
		expect(res.body).toEqual({ engineVersion: '2.3.1' });
		const [type, options] = ctx.helpers.httpRequestWithAuthentication.mock.calls[0] as unknown as [
			string,
			{ url: string; ignoreHttpStatusErrors: boolean; returnFullResponse: boolean },
		];
		expect(type).toBe('sslLabsApi');
		expect(options.url).toBe('https://api.ssllabs.com/api/v4/info');
		expect(options.ignoreHttpStatusErrors).toBe(true);
		expect(options.returnFullResponse).toBe(true);
	});

	it('falls back to the default base URL for unauthenticated calls without a credential', async () => {
		const ctx = fakeContext([{ statusCode: 200, body: { status: 'success' } }], null);
		await sslLabsRequest(asCtx(ctx), {
			path: 'register',
			method: 'POST',
			body: { email: 'a@b.c' },
			authenticate: false,
		});
		const [options] = ctx.helpers.httpRequest.mock.calls[0] as unknown as [{ url: string; json: boolean }];
		expect(options.url).toBe(`${DEFAULT_BASE_URL}/register`);
		expect(options.json).toBe(true);
	});

	it('parses JSON string bodies', async () => {
		const ctx = fakeContext([{ statusCode: 200, body: '{"a":1}' }]);
		const res = await sslLabsRequest(asCtx(ctx), { path: 'info' });
		expect(res.body).toEqual({ a: 1 });
	});

	it('maps HTTP 441 to the unregistered-email message', async () => {
		const ctx = fakeContext([{ statusCode: 441, body: 'unauthorized error' }]);
		await expect(sslLabsRequest(asCtx(ctx), { path: 'analyze' })).rejects.toThrow(
			UNREGISTERED_EMAIL_MESSAGE,
		);
	});

	it('maps a 400 on the email field to the unregistered-email message', async () => {
		const ctx = fakeContext([
			{
				statusCode: 400,
				body: {
					errors: [
						{
							field: 'email',
							message: 'Email not yet registered with us. Please use register api to register first.',
						},
					],
				},
			},
		]);
		const err = await sslLabsRequest(asCtx(ctx), { path: 'analyze' }).catch((e) => e);
		expect(err).toBeInstanceOf(NodeApiError);
		expect(err.message).toBe(UNREGISTERED_EMAIL_MESSAGE);
		expect(err.description).toContain('not yet registered');
	});

	it('surfaces API error fields for a 400 without retrying', async () => {
		const ctx = fakeContext([
			{ statusCode: 400, body: { errors: [{ field: 'host', message: 'qp.mandatory' }] } },
		]);
		const err = await sslLabsRequest(asCtx(ctx), { path: 'analyze' }).catch((e) => e);
		expect(err).toBeInstanceOf(NodeApiError);
		expect(err.message).toContain('host: qp.mandatory');
		expect(err.httpCode).toBe('400');
		expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
	});
});
