import { vi } from 'vitest';
import type { INode } from 'n8n-workflow';

export interface FakeResponse {
	statusCode: number;
	body?: unknown;
	headers?: Record<string, unknown>;
}

export const fakeNode: INode = {
	id: 'node-1',
	name: 'SSL Labs',
	type: 'CUSTOM.sslLabs',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** A minimal execute/poll context whose HTTP helpers replay the given responses in order. */
export function fakeContext(
	responses: FakeResponse[] = [],
	credentials: Record<string, unknown> | null = {
		email: 'ops@example.com',
		baseUrl: 'https://api.ssllabs.com/api/v4/',
	},
) {
	const queue = [...responses];
	const next = vi.fn(async () => {
		const response = queue.shift();
		if (!response) throw new Error('No more fake responses');
		return { headers: {}, ...response };
	});
	return {
		getNode: () => fakeNode,
		getCredentials: vi.fn(async () => {
			if (!credentials) throw new Error('Node does not have any credentials set');
			return credentials;
		}),
		helpers: {
			httpRequest: next,
			httpRequestWithAuthentication: next,
		},
	};
}

export interface FakeExecuteOptions {
	/** Node parameters per input item (one entry per item). */
	items: Array<Record<string, unknown>>;
	responses?: FakeResponse[];
	credentials?: Record<string, unknown> | null;
	continueOnFail?: boolean;
	cancelSignal?: AbortSignal;
}

/** A fake IExecuteFunctions: parameters come from `items[i]`, HTTP from `responses`. */
export function fakeExecute(options: FakeExecuteOptions) {
	const base = fakeContext(options.responses ?? [], options.credentials);
	return {
		...base,
		getInputData: () => options.items.map(() => ({ json: {} })),
		getNodeParameter: (name: string, i: number, fallback?: unknown) => {
			const value = options.items[i]?.[name];
			if (value === undefined) {
				if (fallback === undefined) throw new Error(`Missing parameter "${name}"`);
				return fallback;
			}
			return value;
		},
		continueOnFail: () => options.continueOnFail ?? false,
		getExecutionCancelSignal: () => options.cancelSignal,
	};
}

/** Returns the request options passed to the HTTP helper for call `n`. */
export function requestOf(ctx: ReturnType<typeof fakeContext>, n: number) {
	const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[n] as unknown[];
	return (call.length === 2 ? call[1] : call[0]) as {
		url: string;
		method?: string;
		qs?: Record<string, unknown>;
		body?: Record<string, unknown>;
	};
}
