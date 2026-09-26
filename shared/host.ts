import type { INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function isHostname(value: string): boolean {
	if (value.length > 253) return false;
	const labels = value.split('.');
	return labels.length >= 2 && labels.every((label) => LABEL.test(label));
}

function isIpv6(value: string): boolean {
	return value.includes(':') && /^[0-9a-f:.]+$/.test(value) && value.split('::').length <= 2;
}

/**
 * Reduces user input to the bare hostname SSL Labs expects:
 * `https://Example.com:443/path?q` → `example.com`. Throws when nothing valid remains.
 */
export function normalizeHost(input: unknown, node: INode, itemIndex?: number): string {
	let value = typeof input === 'string' ? input.trim().toLowerCase() : '';
	value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
	value = value.replace(/[/?#].*$/, ''); // path, query, fragment
	value = value.replace(/^.*@/, ''); // userinfo

	const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
	if (bracketed) {
		value = bracketed[1];
	} else if ((value.match(/:/g) ?? []).length === 1) {
		value = value.replace(/:\d*$/, ''); // port on a hostname or IPv4
	}
	value = value.replace(/\.$/, '');

	if (value && (IPV4.test(value) || isIpv6(value) || isHostname(value))) {
		return value;
	}
	throw new NodeOperationError(
		node,
		`"${typeof input === 'string' ? input : String(input)}" is not a valid hostname`,
		{
			itemIndex,
			description:
				'Enter a public hostname such as example.com. URLs are accepted and reduced to their host.',
		},
	);
}
