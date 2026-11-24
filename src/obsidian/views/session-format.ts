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

/** A `[start, end)` character range in the original title. */
export type MatchRange = [number, number];

export interface SessionSearchHit<T extends SessionLike> {
	session: T;
	score: number;
	/** Matched ranges in the displayed title, merged and sorted, for highlighting. */
	ranges: MatchRange[];
}

interface FoldedText {
	/** Lowercased, diacritic-free text. */
	text: string;
	/** `map[i]` = index in the original string of folded char `i`. */
	map: number[];
}

interface Word {
	start: number;
	end: number;
}

interface TermMatch {
	score: number;
	ranges: MatchRange[];
}

/** Fold one character: lowercase, strip diacritics (đ → d), so "cap nhat" finds "Cập Nhật". */
function foldChar(ch: string): string {
	const lower = ch.toLowerCase();
	if (lower === 'đ') return 'd';
	return lower.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function foldText(raw: string): FoldedText {
	let text = '';
	const map: number[] = [];
	let i = 0;
	for (const ch of raw) {
		const folded = foldChar(ch);
		for (const c of folded) {
			text += c;
			map.push(i);
		}
		i += ch.length;
	}
	return { text, map };
}

export function foldSearchText(raw: string): string {
	return foldText(raw).text;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function splitWords(text: string): Word[] {
	const words: Word[] = [];
	let start = -1;
	for (let i = 0; i <= text.length; i++) {
		const isWord = i < text.length && WORD_CHAR.test(text[i]!);
		if (isWord && start === -1) start = i;
		else if (!isWord && start !== -1) {
			words.push({ start, end: i });
			start = -1;
		}
	}
	return words;
}

/** Optimal string alignment distance (Levenshtein + adjacent transpositions), capped. */
function editDistance(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	const rows: number[][] = [];
	for (let i = 0; i <= a.length; i++) {
		rows.push([i]);
	}
	for (let j = 1; j <= b.length; j++) rows[0]![j] = j;
	for (let i = 1; i <= a.length; i++) {
		let rowMin = Infinity;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let v = Math.min(
				rows[i - 1]![j]! + 1,
				rows[i]![j - 1]! + 1,
				rows[i - 1]![j - 1]! + cost,
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				v = Math.min(v, rows[i - 2]![j - 2]! + 1);
			}
			rows[i]![j] = v;
			rowMin = Math.min(rowMin, v);
		}
		if (rowMin > max) return max + 1;
	}
	return rows[a.length]![b.length]!;
}

/** Best way one query term matches the folded title (0 = no match). */
function matchTerm(term: string, text: string, words: Word[]): TermMatch | null {
	let best: TermMatch | null = null;
	const consider = (score: number, ranges: MatchRange[]) => {
		if (!best || score > best.score) best = { score, ranges };
	};

	// Whole word / word prefix / inside a word.
	words.forEach((w, idx) => {
		const word = text.slice(w.start, w.end);
		const firstWordBonus = idx === 0 ? 5 : 0;
		if (word === term) consider(100 + firstWordBonus, [[w.start, w.end]]);
		else if (word.startsWith(term)) {
			consider(70 + firstWordBonus + 20 * (term.length / word.length), [
				[w.start, w.start + term.length],
			]);
		}
	});
	const sub = text.indexOf(term);
	if (sub !== -1) consider(45, [[sub, sub + term.length]]);

	// Initials of consecutive words: "aitu" → "AI Thinking … Usage" style acronyms.
	if (term.length >= 2) {
		for (let s = 0; s + term.length <= words.length; s++) {
			let ok = true;
			for (let k = 0; k < term.length; k++) {
				if (text[words[s + k]!.start] !== term[k]) {
					ok = false;
					break;
				}
			}
			if (ok) {
				const ranges: MatchRange[] = [];
				for (let k = 0; k < term.length; k++) {
					const st = words[s + k]!.start;
					ranges.push([st, st + 1]);
				}
				consider(60, ranges);
				break;
			}
		}
	}

	// Typo tolerance against a word or its same-length prefix: "antigravty", "reveiw".
	if (term.length >= 4) {
		const maxEdits = term.length >= 8 ? 2 : 1;
		for (const w of words) {
			const word = text.slice(w.start, w.end);
			const whole = editDistance(term, word, maxEdits);
			if (whole <= maxEdits) {
				consider(40 - 10 * whole, [[w.start, w.end]]);
				continue;
			}
			if (word.length > term.length) {
				const prefix = word.slice(0, term.length);
				const d = editDistance(term, prefix, maxEdits);
				if (d <= maxEdits) consider(32 - 10 * d, [[w.start, w.start + term.length]]);
			}
		}
	}

	// Loose subsequence ("gtng" → "Greeting"), only when compact enough.
	if (!best && term.length >= 3) {
		const ranges: MatchRange[] = [];
		let pos = 0;
		let first = -1;
		for (const c of term) {
			const at = text.indexOf(c, pos);
			if (at === -1) return null;
			if (first === -1) first = at;
			const last = ranges[ranges.length - 1];
			if (last && last[1] === at) last[1] = at + 1;
			else ranges.push([at, at + 1]);
			pos = at + 1;
		}
		const span = pos - first;
		if (span <= term.length * 3) consider(Math.max(5, 25 - (span - term.length)), ranges);
	}

	return best;
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	const out: MatchRange[] = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else out.push([r[0], r[1]]);
	}
	return out;
}

/** Map folded-text ranges back to original-title ranges. */
function unfoldRanges(ranges: MatchRange[], folded: FoldedText, raw: string): MatchRange[] {
	return mergeRanges(
		ranges.map(([s, e]) => {
			const start = folded.map[s] ?? raw.length;
			const lastOrig = folded.map[e - 1] ?? raw.length - 1;
			const lastChar = raw.codePointAt(lastOrig);
			const width = lastChar !== undefined && lastChar > 0xffff ? 2 : 1;
			return [start, lastOrig + width] as MatchRange;
		}),
	);
}

/**
 * Ranked title search. Every term must match (diacritic- and case-insensitive),
 * as a word, prefix, substring, word initials, a word with a small typo, or a
 * compact subsequence. Stronger matches rank first; ties keep the input order
 * (newest first).
 */
export function searchSessions<T extends SessionLike>(
	sessions: T[],
	query: string,
): SessionSearchHit<T>[] {
	const foldedQuery = foldSearchText(query).trim().replace(/\s+/g, ' ');
	const terms = foldedQuery.split(' ').filter(Boolean);
	if (terms.length === 0) {
		return sessions.map((session) => ({ session, score: 0, ranges: [] }));
	}

	const hits: (SessionSearchHit<T> & { order: number })[] = [];
	sessions.forEach((session, order) => {
		const raw = session.title ?? UNTITLED_SESSION;
		const folded = foldText(raw);
		const words = splitWords(folded.text);
		let score = 0;
		const ranges: MatchRange[] = [];
		for (const term of terms) {
			const m = matchTerm(term, folded.text, words);
			if (!m) return;
			score += m.score;
			ranges.push(...m.ranges);
		}
		// The whole query as a phrase beats scattered terms.
		if (terms.length > 1) {
			const at = folded.text.indexOf(foldedQuery);
			if (at !== -1) {
				score += 40;
				ranges.push([at, at + foldedQuery.length]);
			}
		}
		if (folded.text.startsWith(foldedQuery)) score += 25;
		if (folded.text === foldedQuery) score += 50;
		hits.push({ session, score, ranges: unfoldRanges(ranges, folded, raw), order });
	});

	hits.sort((a, b) => b.score - a.score || a.order - b.order);
	return hits.map(({ session, score, ranges }) => ({ session, score, ranges }));
}

/** Sessions matching every query term, best matches first (see `searchSessions`). */
export function filterSessions<T extends SessionLike>(
	sessions: T[],
	query: string,
): T[] {
	return searchSessions(sessions, query).map((hit) => hit.session);
}
