import { describe, expect, it } from 'vitest';
import { SslLabs } from '../../nodes/SslLabs/SslLabs.node';
import { SslLabsTrigger } from '../../nodes/SslLabsTrigger/SslLabsTrigger.node';

describe('node descriptions', () => {
	it('gives every trigger instance its own properties array (n8n mutates it in place)', () => {
		const a = new SslLabsTrigger();
		a.description.properties.unshift({
			displayName: 'Poll Times',
			name: 'pollTimes',
			type: 'fixedCollection',
			default: {},
		});
		const b = new SslLabsTrigger();
		expect(b.description.properties.filter((p) => p.name === 'pollTimes')).toHaveLength(0);
	});

	it('gives every action node instance its own properties array', () => {
		expect(new SslLabs().description.properties).not.toBe(new SslLabs().description.properties);
	});
});
