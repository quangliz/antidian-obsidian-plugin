export type ChangeOperation =
	| {
			type: 'create';
			path: string;
			content: string;
			baseMtime?: number;
	  }
	| {
			type: 'patch-section';
			path: string;
			heading: string;
			content: string;
			baseMtime?: number;
	  };

export interface ChangeSet {
	id: string;
	operations: ChangeOperation[];
	createdAt: number;
	status: 'staged' | 'applied' | 'rejected' | 'rolled_back';
}

export type ValidationErrorCode =
	| 'path_traversal'
	| 'file_already_exists'
	| 'file_not_found'
	| 'heading_not_found'
	| 'operation_conflict'
	| 'stale_base'
	| 'invalid_content';

export interface ValidationError {
	operationIndex: number;
	path: string;
	code: ValidationErrorCode;
	message: string;
}

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
}

export type DiffLineType = 'context' | 'added' | 'removed';

export interface DiffLine {
	type: DiffLineType;
	content: string;
	oldLineNumber?: number;
	newLineNumber?: number;
}

export interface DiffHunk {
	header?: string;
	lines: DiffLine[];
}

export interface FileDiff {
	path: string;
	operationType: 'create' | 'patch-section';
	heading?: string;
	oldContent: string;
	newContent: string;
	hunks: DiffHunk[];
	additions: number;
	deletions: number;
}

export interface ChangeSetDiff {
	changeSetId: string;
	files: FileDiff[];
	totalAdditions: number;
	totalDeletions: number;
}

export interface AppliedOperation {
	operation: ChangeOperation;
	appliedAt: number;
	previousContent?: string;
}

export interface AppliedChangeSet {
	id: string;
	appliedAt: number;
	operations: AppliedOperation[];
}

export interface MutationService {
	apply(changeSet: ChangeSet): Promise<AppliedChangeSet>;
}
