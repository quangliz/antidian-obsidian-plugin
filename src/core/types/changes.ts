export type ChangeOperation =
	| {
			type: 'create';
			path: string;
			content: string;
	  }
	| {
			type: 'patch-section';
			path: string;
			heading: string;
			content: string;
	  };

export interface ChangeSet {
	id: string;
	operations: ChangeOperation[];
	createdAt: number;
	status: 'staged' | 'applied' | 'rejected' | 'rolled_back';
}
