import { describe, expect, it } from 'vitest';
import { normalizeHost } from '../../shared/host';
import { fakeNode } from '../helpers';

describe('normalizeHost', () => {
	it.each([
		['https://Example.com:443/path', 'example.com'],
		['example.com', 'example.com'],
		['  WWW.SSLLABS.COM  ', 'www.ssllabs.com'],
		['http://user:pass@example.com:8443/a?b#c', 'example.com'],
		['example.com.', 'example.com'],
		['sub.example.co.uk/', 'sub.example.co.uk'],
		['example.com?x=1', 'example.com'],
		['93.184.216.34', '93.184.216.34'],
		['https://93.184.216.34:443/', '93.184.216.34'],
		['[2001:db8::1]:443', '2001:db8::1'],
		['2001:db8::1', '2001:db8::1'],
	])('%s → %s', (input, expected) => {
		expect(normalizeHost(input, fakeNode)).toBe(expected);
	});

	it.each([
		'',
		'   ',
		'localhost',
		'https://',
		'exa mple.com',
		'-bad.com',
		'bad-.com',
		'a..b',
		undefined,
		42,
	])('rejects %s', (input) => {
		expect(() => normalizeHost(input, fakeNode)).toThrow(/not a valid hostname/);
	});
});
