/**
 * Contracts for live agent step checklists (`update_steps` / ACP `plan`) and
 * live high-level focus status updates (`update_focus`).
 */

export type PlanStepStatus =
	| 'pending'
	| 'in_progress'
	| 'done'
	| 'skipped'
	| 'failed';

export interface PlanStep {
	title: string;
	status: PlanStepStatus;
}
