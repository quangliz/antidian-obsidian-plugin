export interface VaultSearchMatch {
	heading?: string;
	snippet: string;
}

export interface VaultSearchResult {
	path: string;
	score: number;
	matches: VaultSearchMatch[];
}

export interface SearchNotesParams {
	query: string;
	limit?: number;
}

export interface ReadNoteParams {
	path: string;
	heading?: string;
}

export interface NoteContent {
	path: string;
	heading?: string;
	content: string;
}

export interface VaultService {
	searchNotes(params: SearchNotesParams): Promise<VaultSearchResult[]>;
	readNote(params: ReadNoteParams): Promise<NoteContent | null>;
}
