import type { Summary } from '../../shared/types';

export const STATE_VERSION = 1;

export type TriggerEvent = 'gradeChanged';

export interface HostState {
	grade: string | null;
	testTime: string | null;
	/** Waiting for an assessment that was DNS/IN_PROGRESS at the last poll. */
	pending: boolean;
	error: string | null;
	lastCheckedAt: number;
}

export interface TriggerState {
	stateVersion: typeof STATE_VERSION;
	hosts: Record<string, HostState>;
}

export interface EventConfig {
	event: TriggerEvent;
	emitErrors: boolean;
}

export type EventItem = Summary & {
	event: TriggerEvent | 'assessmentError';
	previousGrade?: string | null;
};

/** Reads (and if needed initializes or migrates) the trigger state stored in workflow static data. */
export function loadState(staticData: Record<string, unknown>): TriggerState {
	if (
		staticData.stateVersion !== STATE_VERSION ||
		typeof staticData.hosts !== 'object' ||
		!staticData.hosts
	) {
		// Unknown or missing version: start a fresh baseline.
		staticData.stateVersion = STATE_VERSION;
		staticData.hosts = {};
	}
	return staticData as unknown as TriggerState;
}

/** Marks a host as waiting for an assessment. Keeps everything else. */
export function markPending(state: TriggerState, host: string, now: number): void {
	const prev = state.hosts[host];
	state.hosts[host] = prev
		? { ...prev, pending: true, lastCheckedAt: now }
		: { grade: null, testTime: null, pending: true, error: null, lastCheckedAt: now };
}

/**
 * Applies a finished (READY or ERROR) assessment to the host state and returns the events to
 * emit. A host without stored state (or with only pending/error state) is a baseline: its first
 * READY result is stored without emitting.
 */
export function applyResult(
	state: TriggerState,
	summary: Summary,
	config: EventConfig,
	now: number,
): EventItem[] {
	const prev = state.hosts[summary.host];
	const baseline = !prev || (prev.grade === null && prev.testTime === null);
	const events: EventItem[] = [];

	if (summary.status === 'ERROR') {
		const error = summary.statusMessage ?? 'Assessment failed';
		if (config.emitErrors && prev && prev.error !== error) {
			events.push({ ...summary, event: 'assessmentError' });
		}
		state.hosts[summary.host] = {
			...(prev ?? { grade: null, testTime: null }),
			pending: false,
			error,
			lastCheckedAt: now,
		};
		return events;
	}

	if (
		!baseline &&
		config.event === 'gradeChanged' &&
		summary.grade !== null &&
		prev.grade !== summary.grade
	) {
		events.push({ ...summary, event: 'gradeChanged', previousGrade: prev.grade });
	}

	state.hosts[summary.host] = {
		grade: summary.grade ?? prev?.grade ?? null,
		testTime: summary.testTime,
		pending: false,
		error: null,
		lastCheckedAt: now,
	};
	return events;
}
