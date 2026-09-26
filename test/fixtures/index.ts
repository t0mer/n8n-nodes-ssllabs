import type { Host } from '../../shared/types';
import dns from './host-dns.json';
import error from './host-error.json';
import expiring from './host-expiring.json';
import failedEndpoint from './host-failed-endpoint.json';
import inProgress from './host-in-progress.json';
import { now } from './now.json';
import ready from './host-ready.json';

const clone = (h: unknown) => structuredClone(h) as Host;

export const NOW = now;
export const fixtures = {
	ready: () => clone(ready),
	inProgress: () => clone(inProgress),
	dns: () => clone(dns),
	error: () => clone(error),
	failedEndpoint: () => clone(failedEndpoint),
	expiring: () => clone(expiring),
};
