import {
	VaultService,
	VaultSearchResult,
	SearchNotesParams,
	ReadNoteParams,
	NoteContent,
} from '../types/vault';
import { ActiveContext } from '../types/context';

export interface ToolContext {
	context?: ActiveContext;
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
): Tool<SearchNotesParams, VaultSearchResult[]> {
	return {
		name: 'search_notes',
		description:
			'Search vault notes by keywords matching titles, headings, wikilinks, and content.',
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
		): Promise<VaultSearchResult[]> => {
			const query =
				typeof input?.query === 'string' ? input.query : '';
			const limit =
				typeof input?.limit === 'number' ? input.limit : undefined;
			return vaultService.searchNotes({ query, limit });
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
		): Promise<NoteContent | null> => {
			const path = typeof input?.path === 'string' ? input.path : '';
			const heading =
				typeof input?.heading === 'string' ? input.heading : undefined;
			return vaultService.readNote({ path, heading });
		},
	};
}
