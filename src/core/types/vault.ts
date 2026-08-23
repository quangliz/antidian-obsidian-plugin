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
	mtime?: number;
}

export interface VaultInspectionService {
	normalizePath(path: string): string;
	isPathWithinVault(path: string): boolean;
	fileExists(path: string): Promise<boolean>;
	getFileMtime(path: string): Promise<number | null>;
	headingExists(path: string, heading: string): Promise<boolean>;
}

export interface VaultService extends VaultInspectionService {
	searchNotes(params: SearchNotesParams): Promise<SearchResult[]>;
	readNote(params: ReadNoteParams): Promise<NoteContent | null>;
}
