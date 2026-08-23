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
