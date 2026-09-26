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
