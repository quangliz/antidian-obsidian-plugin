/**
 * Contracts for ACP form elicitation (`elicitation/create`), including `agy`'s
 * built-in `ask_question` multiple-choice prompts and general form prompts.
 */

export type ElicitationAction = 'accept' | 'decline' | 'cancel';

export interface ElicitationOption {
	/** Wire value sent back in `content` (e.g. `"1"`, `"2"`, or enum string). */
	value: string;
	/** Display label with any leading `(Recommended)` tag stripped. */
	label: string;
	/** True when the option carried a leading `(Recommended)` prefix. */
	recommended?: boolean;
}

export type ElicitationFieldKind =
	| 'single-select'
	| 'multi-select'
	| 'text'
	| 'number'
	| 'boolean';

export interface ElicitationField {
	/** Schema property key (e.g. `"q1"`). */
	key: string;
	/** Paired free-form `"Other"` property key when present (e.g. `"q1_other"`). */
	otherKey?: string;
	otherLabel?: string;
	otherDescription?: string;
	kind: ElicitationFieldKind;
	title: string;
	description?: string;
	required?: boolean;
	options?: ElicitationOption[];
	defaultValue?: unknown;
}

export interface ElicitationRequest {
	sessionId?: string;
	toolCallId?: string;
	mode: 'form';
	message: string;
	fields: ElicitationField[];
}

export interface ElicitationAnswerSummary {
	question: string;
	answer: string;
}

export interface ElicitationResponse {
	action: ElicitationAction;
	/** Encoded ACP form values keyed by schema property name (only for `accept`). */
	content?: Record<string, unknown>;
	/** Human-readable Q&A summary for trace/UI display (not sent over ACP). */
	summary?: ElicitationAnswerSummary[];
}

export type ElicitationHandler = (
	request: ElicitationRequest,
) => Promise<ElicitationResponse>;
