export interface ActiveContext {
	activeFile?: string;
	selection?: string;
	cursor?: {
		line: number;
		ch: number;
	};
}

export interface ContextReference {
	path: string;
	heading?: string;
	reason: string;
}

export interface ContextService {
	getActiveContext(): ActiveContext;
	onContextChange(callback: (context: ActiveContext) => void): () => void;
}
