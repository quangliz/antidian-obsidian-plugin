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
	isStaged?: boolean;
}

export interface ListNotesParams {
	folder?: string;
	tag?: string;
	sortBy?: 'mtime' | 'name';
	limit?: number;
}

export interface NoteListItem {
	path: string;
	basename: string;
	mtime: number;
	tags?: string[];
}

export interface NoteHeading {
	heading: string;
	level: number;
	line: number;
}

export interface NoteOutline {
	path: string;
	headings: NoteHeading[];
	frontmatter?: Record<string, unknown>;
	tags: string[];
	outgoingLinks: string[];
	backlinks: string[];
	mtime?: number;
	charCount: number;
	isStaged?: boolean;
}

export interface VaultInspectionService {
	normalizePath(path: string): string;
	isPathWithinVault(path: string): boolean;
	fileExists(path: string): Promise<boolean>;
	getFileMtime(path: string): Promise<number | null>;
	headingExists(path: string, heading: string): Promise<boolean>;
}

export interface VaultMutationService {
	createNote(path: string, content: string): Promise<void>;
	patchSection(path: string, heading: string, content: string): Promise<void>;
}

export interface VaultService
	extends VaultInspectionService,
		VaultMutationService {
	searchNotes(params: SearchNotesParams): Promise<SearchResult[]>;
	readNote(params: ReadNoteParams): Promise<NoteContent | null>;
	listNotes?(params?: ListNotesParams): Promise<NoteListItem[]>;
	getNoteOutline?(path: string): Promise<NoteOutline | null>;
}
