import {
	VaultService,
	SearchResult,
	SearchNotesParams,
	ReadNoteParams,
	NoteContent,
} from '../types/vault';
import { ActiveContext, ContextReference } from '../types/context';

export interface ToolContext {
	context?: ActiveContext;
	recordContext?: (ref: ContextReference) => void;
	[key: string]: unknown;
}

export interface Tool<I = unknown, O = unknown> {
	name: string;
	description: string;
	schema: Record<string, unknown>;
	execute(input: I, ctx?: ToolContext): Promise<O>;
}

export interface ToolDeclaration {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export class ToolRegistry {
	private tools = new Map<string, Tool>();

	register<I, O>(tool: Tool<I, O>): this {
		this.tools.set(tool.name, tool);
		return this;
	}

	unregister(name: string): boolean {
		return this.tools.delete(name);
	}

	get(name: string): Tool | undefined {
		return this.tools.get(name);
	}

	getAll(): Tool[] {
		return Array.from(this.tools.values());
	}

	getDeclarations(): ToolDeclaration[] {
		return this.getAll().map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.schema,
		}));
	}
}

export function createSearchNotesTool(
	vaultService: VaultService,
): Tool<SearchNotesParams, SearchResult[]> {
	return {
		name: 'search_notes',
		description:
			'Search vault notes and sections. Returns structured matches with path, heading, matchType (title|heading|text|property|link), and snippet to pinpoint relevant sections before reading.',
		schema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description: 'The search query or keywords',
				},
				limit: {
					type: 'number',
					description: 'Maximum number of results to return (default 10)',
				},
			},
			required: ['query'],
		},
		execute: async (
			input: SearchNotesParams,
			ctx?: ToolContext,
		): Promise<SearchResult[]> => {
			const query =
				typeof input?.query === 'string' ? input.query : '';
			const limit =
				typeof input?.limit === 'number' ? input.limit : undefined;
			const results = await vaultService.searchNotes({ query, limit });

			if (ctx?.recordContext) {
				for (const res of results) {
					ctx.recordContext({
						path: res.path,
						heading: res.heading,
						reason: `Search (${res.matchType})`,
					});
				}
			}

			return results;
		},
	};
}

export function createReadNoteTool(
	vaultService: VaultService,
): Tool<ReadNoteParams, NoteContent | null> {
	return {
		name: 'read_note',
		description:
			'Read the content of a note or a specific heading section in the vault.',
		schema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Vault path to the note (e.g. "llama.cpp.md")',
				},
				heading: {
					type: 'string',
					description: 'Optional heading section to read',
				},
			},
			required: ['path'],
		},
		execute: async (
			input: ReadNoteParams,
			ctx?: ToolContext,
		): Promise<NoteContent | null> => {
			const path = typeof input?.path === 'string' ? input.path : '';
			const heading =
				typeof input?.heading === 'string' ? input.heading : undefined;
			const note = await vaultService.readNote({ path, heading });

			if (note && ctx?.recordContext) {
				ctx.recordContext({
					path: note.path,
					heading: note.heading,
					reason: 'Read note',
				});
			}

			return note;
		},
	};
}
