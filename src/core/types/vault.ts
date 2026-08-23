export type SearchMatchType =
	| 'title'
	| 'text'
	| 'heading'
	| 'property'
	| 'link';

export interface SearchResult {
	path: string;
	heading?: string;
	snippet: string;
	score: number;
	matchType: SearchMatchType;
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
	searchNotes(params: SearchNotesParams): Promise<SearchResult[]>;
	readNote(params: ReadNoteParams): Promise<NoteContent | null>;
}
