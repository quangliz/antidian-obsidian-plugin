export interface ActiveContext {
	activeFile?: string;
	selection?: string;
	cursor?: {
		line: number;
		ch: number;
	};
}

export interface ContextService {
	getActiveContext(): ActiveContext;
	onContextChange(callback: (context: ActiveContext) => void): () => void;
}
