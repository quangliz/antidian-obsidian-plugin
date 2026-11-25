import type {
	ElicitationAction,
	ElicitationAnswerSummary,
	ElicitationField,
	ElicitationOption,
	ElicitationRequest,
	ElicitationResponse,
} from '../types/elicitation';

export interface ElicitationFieldDraft {
	/** Selected option values (`single-select` uses at most 1; `multi-select` uses 0+). */
	selectedValues?: string[];
	/** Free-form `"Other"` write-in text when the field has `otherKey`. */
	otherText?: string;
	/** Whether the user explicitly chose `"Other"` (single-select) or checked it (multi-select). */
	otherSelected?: boolean;
	/** Value for `text` or `number` fields. */
	textValue?: string;
	/** Value for `boolean` fields. */
	booleanValue?: boolean;
}

export type ElicitationDraftMap = Record<string, ElicitationFieldDraft>;

export interface ParsedElicitationResult {
	request: ElicitationRequest | null;
	/** Set when the agent requested an unsupported elicitation mode (e.g. `url`). */
	unsupportedMode?: string;
}

const RECOMMENDED_PREFIX = /^\(recommended\)\s*/i;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const nonEmptyStr = (v: unknown): string | undefined =>
	typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** Parses `(Recommended)` prefix into a clean label + flag. */
export function parseOptionLabel(raw: string): {
	label: string;
	recommended: boolean;
} {
	const trimmed = raw.trim();
	if (RECOMMENDED_PREFIX.test(trimmed)) {
		const stripped = trimmed.replace(RECOMMENDED_PREFIX, '').trim();
		if (stripped) {
			return { label: stripped, recommended: true };
		}
	}
	return { label: trimmed, recommended: false };
}

function parseChoiceList(raw: unknown): ElicitationOption[] {
	if (!Array.isArray(raw)) return [];
	const out: ElicitationOption[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const val = entry.const;
		if (typeof val !== 'string' && typeof val !== 'number') continue;
		const value = String(val);
		const rawTitle = nonEmptyStr(entry.title) ?? value;
		const { label, recommended } = parseOptionLabel(rawTitle);
		out.push({ value, label, ...(recommended ? { recommended: true } : {}) });
	}
	return out;
}

function parseEnumList(
	rawEnum: unknown,
	rawNames?: unknown,
): ElicitationOption[] {
	if (!Array.isArray(rawEnum)) return [];
	const items: unknown[] = rawEnum;
	const names: unknown[] = Array.isArray(rawNames) ? rawNames : [];
	const out: ElicitationOption[] = [];
	for (let i = 0; i < items.length; i++) {
		const val = items[i];
		if (typeof val !== 'string' && typeof val !== 'number') continue;
		const value = String(val);
		const rawTitle = nonEmptyStr(names[i]) ?? value;
		const { label, recommended } = parseOptionLabel(rawTitle);
		out.push({ value, label, ...(recommended ? { recommended: true } : {}) });
	}
	return out;
}

function parseSchemaField(
	key: string,
	schema: Record<string, unknown>,
	required: boolean,
): ElicitationField | null {
	const type = typeof schema.type === 'string' ? schema.type : '';
	const title = nonEmptyStr(schema.title) ?? key;
	const description = nonEmptyStr(schema.description);

	// Multi-select array (agy sends `type: "array"` with `items.anyOf` or `items.enum`).
	if (type === 'array' && isRecord(schema.items)) {
		const options = [
			...parseChoiceList(schema.items.anyOf),
			...parseChoiceList(schema.items.oneOf),
		];
		const resolved =
			options.length > 0
				? options
				: parseEnumList(schema.items.enum, schema.items.enumNames);
		if (resolved.length > 0) {
			return {
				key,
				kind: 'multi-select',
				title,
				description,
				required,
				options: resolved,
				defaultValue: schema.default,
			};
		}
	}

	// Single-select string (agy sends `type: "string"` with `oneOf`; generic forms may use `enum`).
	const oneOfOptions = [
		...parseChoiceList(schema.oneOf),
		...parseChoiceList(schema.anyOf),
	];
	const singleOptions =
		oneOfOptions.length > 0
			? oneOfOptions
			: parseEnumList(schema.enum, schema.enumNames);
	if (singleOptions.length > 0) {
		return {
			key,
			kind: 'single-select',
			title,
			description,
			required,
			options: singleOptions,
			defaultValue: schema.default,
		};
	}

	if (type === 'boolean') {
		return {
			key,
			kind: 'boolean',
			title,
			description,
			required,
			defaultValue: schema.default,
		};
	}

	if (type === 'number' || type === 'integer') {
		return {
			key,
			kind: 'number',
			title,
			description,
			required,
			defaultValue: schema.default,
		};
	}

	if (type === 'string' || !type) {
		return {
			key,
			kind: 'text',
			title,
			description,
			required,
			defaultValue: schema.default,
		};
	}

	return null;
}

/**
 * Parses an incoming ACP `elicitation/create` request into structured fields.
 * Pairs `agy`'s `<key>` + `<key>_other` properties into a single question with
 * an integrated write-in "Other" option.
 */
export function parseElicitationRequest(
	params: Record<string, unknown>,
): ParsedElicitationResult {
	const mode = typeof params.mode === 'string' ? params.mode : 'form';
	if (mode !== 'form') {
		return { request: null, unsupportedMode: mode };
	}

	const schema = isRecord(params.requestedSchema)
		? params.requestedSchema
		: undefined;
	const props =
		schema && isRecord(schema.properties) ? schema.properties : undefined;
	if (!props) {
		return { request: null };
	}

	const requiredKeys = new Set<string>(
		Array.isArray(schema?.required)
			? schema.required.filter((k): k is string => typeof k === 'string')
			: [],
	);

	// Identify `<key>_other` string fields paired with a choice field `<key>`.
	const consumedOtherKeys = new Set<string>();
	const fields: ElicitationField[] = [];

	for (const [key, rawProp] of Object.entries(props)) {
		if (consumedOtherKeys.has(key)) continue;
		if (!isRecord(rawProp)) continue;

		const field = parseSchemaField(key, rawProp, requiredKeys.has(key));
		if (!field) continue;

		if (
			field.kind === 'single-select' ||
			field.kind === 'multi-select'
		) {
			const otherKey = `${key}_other`;
			const otherProp = props[otherKey];
			if (
				isRecord(otherProp) &&
				(otherProp.type === 'string' || otherProp.type === undefined)
			) {
				field.otherKey = otherKey;
				field.otherLabel = nonEmptyStr(otherProp.title) ?? 'Other';
				field.otherDescription = nonEmptyStr(otherProp.description);
				consumedOtherKeys.add(otherKey);
			}
		}

		fields.push(field);
	}

	if (fields.length === 0) {
		return { request: null };
	}

	return {
		request: {
			sessionId: nonEmptyStr(params.sessionId),
			toolCallId: nonEmptyStr(params.toolCallId),
			mode: 'form',
			message:
				nonEmptyStr(params.message) ??
				(fields.length === 1
					? 'The agent has a question.'
					: `The agent has ${fields.length} questions.`),
			fields,
		},
	};
}

/** True when a single field currently has a non-empty answer in the draft. */
export function isFieldAnswered(
	field: ElicitationField,
	draft?: ElicitationFieldDraft,
): boolean {
	if (!draft) return false;
	const trimmedOther = (draft.otherText ?? '').trim();
	switch (field.kind) {
		case 'single-select': {
			if (draft.otherSelected) return trimmedOther.length > 0;
			return (draft.selectedValues?.length ?? 0) > 0 || trimmedOther.length > 0;
		}
		case 'multi-select':
			return (
				(draft.selectedValues?.length ?? 0) > 0 ||
				(Boolean(field.otherKey) && trimmedOther.length > 0)
			);
		case 'text':
			return (draft.textValue ?? '').trim().length > 0;
		case 'number': {
			const raw = (draft.textValue ?? '').trim();
			return raw.length > 0 && Number.isFinite(Number(raw));
		}
		case 'boolean':
			return typeof draft.booleanValue === 'boolean';
	}
}

/**
 * Encodes user selections into the exact ACP `elicitation/create` `accept`
 * payload plus a human-readable Q&A summary for trace rendering.
 */
export function buildElicitationResponse(
	request: ElicitationRequest,
	drafts: ElicitationDraftMap,
): ElicitationResponse {
	const content: Record<string, unknown> = {};
	const summary: ElicitationAnswerSummary[] = [];

	for (const field of request.fields) {
		const draft = drafts[field.key];
		if (!draft) continue;
		const optionLabelByValue = new Map(
			(field.options ?? []).map((o) => [o.value, o.label]),
		);
		const trimmedOther = (draft.otherText ?? '').trim();

		if (field.kind === 'single-select') {
			const picked = draft.selectedValues?.[0];
			if (field.otherKey && (draft.otherSelected || (!picked && trimmedOther))) {
				if (trimmedOther) {
					content[field.otherKey] = trimmedOther;
					summary.push({ question: field.title, answer: trimmedOther });
				}
			} else if (picked !== undefined) {
				content[field.key] = picked;
				summary.push({
					question: field.title,
					answer: optionLabelByValue.get(picked) ?? picked,
				});
			}
			continue;
		}

		if (field.kind === 'multi-select') {
			const selected = (draft.selectedValues ?? []).filter((v) => v.length > 0);
			const labels: string[] = [];
			if (selected.length > 0) {
				content[field.key] = selected;
				for (const val of selected) {
					labels.push(optionLabelByValue.get(val) ?? val);
				}
			}
			if (field.otherKey && trimmedOther) {
				content[field.otherKey] = trimmedOther;
				labels.push(trimmedOther);
			}
			if (labels.length > 0) {
				summary.push({ question: field.title, answer: labels.join(', ') });
			}
			continue;
		}

		if (field.kind === 'text') {
			const val = (draft.textValue ?? '').trim();
			if (val) {
				content[field.key] = val;
				summary.push({ question: field.title, answer: val });
			}
			continue;
		}

		if (field.kind === 'number') {
			const raw = (draft.textValue ?? '').trim();
			const parsed = Number(raw);
			if (raw && Number.isFinite(parsed)) {
				content[field.key] = parsed;
				summary.push({ question: field.title, answer: String(parsed) });
			}
			continue;
		}

		if (field.kind === 'boolean' && typeof draft.booleanValue === 'boolean') {
			content[field.key] = draft.booleanValue;
			summary.push({
				question: field.title,
				answer: draft.booleanValue ? 'Yes' : 'No',
			});
		}
	}

	return {
		action: 'accept',
		content,
		summary,
	};
}

export interface ParsedAskQuestionOutcome {
	action: ElicitationAction;
	answers: ElicitationAnswerSummary[];
}

/**
 * Extracts structured Q&A answers for an `ask_question` tool step, handling both
 * live elicitation outcomes (`{ action, answers }`) and replayed `agy` transcript
 * strings (`"A1: Blue\nA2: Apple, Mango"`).
 */
export function parseAskQuestionOutcome(
	args: Record<string, unknown> | undefined,
	output: unknown,
): ParsedAskQuestionOutcome | null {
	if (isRecord(output)) {
		const action = output.action;
		if (action === 'decline' || action === 'cancel') {
			return { action, answers: [] };
		}
		if (action === 'accept' && Array.isArray(output.answers)) {
			const answers: ElicitationAnswerSummary[] = [];
			for (const item of output.answers) {
				if (!isRecord(item)) continue;
				const q = nonEmptyStr(item.question);
				const a = nonEmptyStr(item.answer);
				if (q && a) answers.push({ question: q, answer: a });
			}
			return { action: 'accept', answers };
		}
	}

	if (typeof output === 'string' && output.trim()) {
		const text = output.trim();
		if (/declined|skipped/i.test(text) && !/^A\d+:/m.test(text)) {
			return { action: 'decline', answers: [] };
		}
		if (/cancel/i.test(text) && !/^A\d+:/m.test(text)) {
			return { action: 'cancel', answers: [] };
		}

		const rawQuestions = Array.isArray(args?.questions)
			? args.questions.filter(isRecord)
			: [];
		const answers: ElicitationAnswerSummary[] = [];
		const lines = text.split(/\r?\n/);
		for (const line of lines) {
			const match = line.match(/^A(\d+):\s*(.+)$/);
			if (!match || !match[1] || !match[2]) continue;
			const idx = Number.parseInt(match[1], 10) - 1;
			const questionObj = rawQuestions[idx];
			const question =
				(questionObj ? nonEmptyStr(questionObj.question) : undefined) ??
				`Question ${idx + 1}`;
			answers.push({ question, answer: match[2].trim() });
		}
		if (answers.length > 0) {
			return { action: 'accept', answers };
		}
	}

	return null;
}
