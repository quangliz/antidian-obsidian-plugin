/**
 * Pure helpers for the session picker (no Obsidian imports, so they are unit-testable).
 */

export interface SessionLike {
	sessionId: string;
	title?: string;
	updatedAt?: string;
}

export interface SessionGroup<T extends SessionLike> {
	label: string;
	sessions: T[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const UNTITLED_SESSION = 'Untitled session';

function parseTime(iso?: string): number | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : null;
}

function startOfDay(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** Buckets sessions (already sorted newest first) into recency groups. */
export function groupSessionsByRecency<T extends SessionLike>(
	sessions: T[],
	now: number = Date.now(),
): SessionGroup<T>[] {
	const today = startOfDay(now);
	const buckets: SessionGroup<T>[] = [
		{ label: 'Today', sessions: [] },
		{ label: 'Yesterday', sessions: [] },
		{ label: 'Previous 7 days', sessions: [] },
		{ label: 'Previous 30 days', sessions: [] },
		{ label: 'Older', sessions: [] },
	];
	for (const s of sessions) {
		const t = parseTime(s.updatedAt);
		let idx = 4;
		if (t !== null) {
			if (t >= today) idx = 0;
			else if (t >= today - DAY_MS) idx = 1;
			else if (t >= today - 7 * DAY_MS) idx = 2;
			else if (t >= today - 30 * DAY_MS) idx = 3;
		}
		buckets[idx]!.sessions.push(s);
	}
	return buckets.filter((b) => b.sessions.length > 0);
}

/** Compact relative time: "now", "5m", "3h", "2d", or a short date. */
export function formatRelativeTime(
	iso: string | undefined,
	now: number = Date.now(),
): string {
	const t = parseTime(iso);
	if (t === null) return '';
	const diff = Math.max(0, now - t);
	const min = Math.floor(diff / 60_000);
	if (min < 1) return 'now';
	if (min < 60) return `${min}m`;
	const hours = Math.floor(min / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	const d = new Date(t);
	const sameYear = d.getFullYear() === new Date(now).getFullYear();
	return d.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		...(sameYear ? {} : { year: 'numeric' }),
	});
}

/** Case-insensitive title filter; every whitespace-separated term must match. */
export function filterSessions<T extends SessionLike>(
	sessions: T[],
	query: string,
): T[] {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return sessions;
	return sessions.filter((s) => {
		const title = (s.title ?? UNTITLED_SESSION).toLowerCase();
		return terms.every((term) => title.includes(term));
	});
}
