export type ChangeOperation = (
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
	  }
	| {
			type: 'edit';
			path: string;
			content: string;
			baseMtime?: number;
	  }
	| {
			type: 'replace-block';
			path: string;
			oldText: string;
			newText: string;
			baseMtime?: number;
	  }
	| {
			type: 'append';
			path: string;
			content: string;
			heading?: string;
			baseMtime?: number;
	  }
	| {
			type: 'update-frontmatter';
			path: string;
			set?: Record<string, unknown>;
			remove?: string[];
			baseMtime?: number;
	  }
) & {
	/** Assigned by ChangeStagingManager.stage; identifies the op across UI and review. */
	id?: string;
};

export type ChangeOperationType = ChangeOperation['type'];

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
	| 'invalid_content'
	| 'target_not_found'
	| 'ambiguous_match';

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
	operationType: ChangeOperationType;
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

export interface FileSnapshot {
	path: string;
	content?: string;
	existed: boolean;
}

export interface ChangeSetSnapshot {
	changeSetId: string;
	createdAt: number;
	files: FileSnapshot[];
}

export interface RollbackResult {
	success: boolean;
	restoredCount: number;
	errors: string[];
}

export interface MutationService {
	apply(changeSet: ChangeSet): Promise<AppliedChangeSet>;
	captureSnapshot(changeSet: ChangeSet): Promise<ChangeSetSnapshot>;
	rollback(snapshot: ChangeSetSnapshot): Promise<RollbackResult>;
}
