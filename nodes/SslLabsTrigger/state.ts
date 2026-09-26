import { isWorseThan, type Grade } from '../../shared/grades';
import type { Summary, SummaryCertificate } from '../../shared/types';

export const STATE_VERSION = 1;

const DAY_MS = 86_400_000;

/** Whole days from `now` until an ISO date; recomputed each poll so stored certificates don't go stale. */
function daysUntil(iso: string | null | undefined, now: number): number | null {
	const ms = iso ? Date.parse(iso) : Number.NaN;
	return Number.isNaN(ms) ? null : Math.floor((ms - now) / DAY_MS);
}

export type TriggerEvent = 'gradeChanged' | 'gradeBelowThreshold' | 'certificateExpiring';

export interface HostState {
	grade: string | null;
	testTime: string | null;
	/** Threshold in effect when `belowThreshold` was computed. */
	threshold: string | null;
	/** Grade was worse than the threshold at the last READY result (alert already sent). */
	belowThreshold: boolean;
	certificate: SummaryCertificate | null;
	/** An expiry alert was already sent for `certificate`. Re-armed by a new certificate. */
	certAlerted: boolean;
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
	thresholdGrade: Grade;
	daysBeforeExpiry: number;
}

export type EventItem = Summary & {
	event: TriggerEvent | 'assessmentError';
	previousGrade?: string | null;
	thresholdGrade?: string;
	previousCertificate?: SummaryCertificate | null;
};

const EMPTY_HOST: Omit<HostState, 'lastCheckedAt'> = {
	grade: null,
	testTime: null,
	threshold: null,
	belowThreshold: false,
	certificate: null,
	certAlerted: false,
	pending: false,
	error: null,
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

/** Records that a host was attempted (moves it to the back of the queue). Keeps everything else. */
export function touch(state: TriggerState, host: string, now: number): void {
	state.hosts[host] = { ...(state.hosts[host] ?? EMPTY_HOST), lastCheckedAt: now };
}

/** Marks a host as waiting for an assessment. Keeps everything else. */
export function markPending(state: TriggerState, host: string, now: number): void {
	const prev = state.hosts[host];
	state.hosts[host] = prev
		? { ...prev, pending: true, lastCheckedAt: now }
		: { ...EMPTY_HOST, pending: true, lastCheckedAt: now };
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
		// Only after a first real result: entries created by touch/markPending are still a baseline.
		const hadResult = !!prev && (prev.testTime !== null || prev.error !== null);
		if (config.emitErrors && hadResult && prev.error !== error) {
			events.push({ ...summary, event: 'assessmentError' });
		}
		state.hosts[summary.host] = {
			...(prev ?? EMPTY_HOST),
			pending: false,
			error,
			lastCheckedAt: now,
		};
		return events;
	}

	if (
		!baseline &&
		config.event === 'gradeChanged' &&
		prev.grade !== null &&
		summary.grade !== null &&
		prev.grade !== summary.grade
	) {
		events.push({ ...summary, event: 'gradeChanged', previousGrade: prev.grade });
	}

	// Threshold (only tracked while that event is selected): fire once on crossing below it and
	// re-arm when the grade recovers. A new or changed threshold starts from a silent baseline.
	let threshold: string | null = null;
	let belowThreshold = false;
	if (config.event === 'gradeBelowThreshold') {
		// Tracking starts at the first graded result for this threshold (a silent baseline).
		const tracked = !baseline && prev.threshold === config.thresholdGrade;
		if (summary.grade !== null) {
			const below = isWorseThan(summary.grade, config.thresholdGrade);
			if (tracked && below && !prev.belowThreshold) {
				events.push({
					...summary,
					event: 'gradeBelowThreshold',
					previousGrade: prev.grade,
					thresholdGrade: config.thresholdGrade,
				});
			}
			threshold = config.thresholdGrade;
			belowThreshold = below;
		} else if (tracked) {
			threshold = config.thresholdGrade;
			belowThreshold = prev.belowThreshold;
		}
	}

	// Certificate expiry: fire once per certificate; a new certificate re-arms. A certificate is
	// only marked alerted when an alert is actually emitted, so one that is already expiring at
	// the baseline (or when this event gets selected later) still alerts on the next poll.
	const certificate = summary.certificate ?? prev?.certificate ?? null;
	const newCert = (certificate?.fingerprint ?? null) !== (prev?.certificate?.fingerprint ?? null);
	let certAlerted = newCert ? false : (prev?.certAlerted ?? false);
	const days = daysUntil(certificate?.notAfter, now);
	if (
		!baseline &&
		config.event === 'certificateExpiring' &&
		!certAlerted &&
		days !== null &&
		days <= config.daysBeforeExpiry
	) {
		events.push({
			...summary,
			certificate: certificate && { ...certificate, daysUntilExpiry: days },
			event: 'certificateExpiring',
			...(newCert && prev?.certificate ? { previousCertificate: prev.certificate } : {}),
		});
		certAlerted = true;
	}

	state.hosts[summary.host] = {
		grade: summary.grade ?? prev?.grade ?? null,
		testTime: summary.testTime,
		threshold,
		belowThreshold,
		certificate,
		certAlerted,
		pending: false,
		error: null,
		lastCheckedAt: now,
	};
	return events;
}
