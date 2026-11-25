import type { PlanStep, PlanStepStatus } from '../types/plan';

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** Normalizes both `agy` (`done`) and standard ACP (`completed`) step statuses. */
export function normalizePlanStepStatus(raw: unknown): PlanStepStatus {
	if (typeof raw !== 'string') return 'pending';
	switch (raw.trim().toLowerCase()) {
		case 'done':
		case 'completed':
			return 'done';
		case 'in_progress':
		case 'in-progress':
		case 'running':
		case 'active':
			return 'in_progress';
		case 'skipped':
		case 'cancelled':
		case 'canceled':
			return 'skipped';
		case 'failed':
		case 'error':
			return 'failed';
		default:
			return 'pending';
	}
}

/**
 * Parses step lists from either `agy`'s `update_steps` (`{ steps: [{ title, status }] }`)
 * or standard ACP `sessionUpdate: "plan"` (`{ entries: [{ content, status }] }`).
 */
export function parsePlanSteps(raw: unknown): PlanStep[] {
	let list: unknown[] | undefined;
	if (Array.isArray(raw)) {
		list = raw;
	} else if (isRecord(raw)) {
		if (Array.isArray(raw.steps)) list = raw.steps;
		else if (Array.isArray(raw.entries)) list = raw.entries;
	}
	if (!list) return [];

	const out: PlanStep[] = [];
	for (const item of list) {
		if (!isRecord(item)) continue;
		const rawTitle =
			typeof item.title === 'string'
				? item.title
				: typeof item.content === 'string'
					? item.content
					: '';
		const title = rawTitle.trim();
		if (!title) continue;
		out.push({
			title,
			status: normalizePlanStepStatus(item.status),
		});
	}
	return out;
}

/** Extracts focus status text from `update_focus` args or raw strings. */
export function parseFocusText(raw: unknown): string | null {
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		return trimmed || null;
	}
	if (isRecord(raw) && typeof raw.focus === 'string') {
		const trimmed = raw.focus.trim();
		return trimmed || null;
	}
	return null;
}

/** Returns the first active (`in_progress`) step title, if any. */
export function getActivePlanFocus(steps: PlanStep[]): string | null {
	const active = steps.find((s) => s.status === 'in_progress');
	return active?.title ?? null;
}

/** Formats live elapsed duration compactly (e.g. `4s`, `20s`, `1m 5s`). */
export function formatElapsedSeconds(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}
