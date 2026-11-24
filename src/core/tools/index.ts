import {
	VaultService,
	SearchResult,
	SearchNotesParams,
	ReadNoteParams,
	NoteContent,
} from '../types/vault';
import { ActiveContext, ContextReference } from '../types/context';
import { ChangeStagingManager } from '../transactions';

export interface ToolContext {
	context?: ActiveContext;
	recordContext?: (ref: ContextReference) => void;
	recordReadMtime?: (path: string, mtime: number) => void;
	getReadMtime?: (path: string) => number | undefined;
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
						snippet: res.snippet,
						chars: res.snippet?.length,
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

			if (note) {
				if (ctx?.recordContext) {
					ctx.recordContext({
						path: note.path,
						heading: note.heading,
						reason: 'Read note',
						chars: note.content.length,
						snippet:
							note.content.length > 200
								? `${note.content.slice(0, 200).trim()}...`
								: note.content.trim(),
					});
				}
				if (note.mtime && ctx?.recordReadMtime) {
					ctx.recordReadMtime(note.path, note.mtime);
				}
			}

			return note;
		},
	};
}

export interface CreateNoteInput {
	path: string;
	content: string;
}

export function createCreateNoteTool(
	staging: ChangeStagingManager,
): Tool<CreateNoteInput, Record<string, unknown>> {
	return {
		name: 'create_note',
		description:
			'Stage the creation of a new file in the vault (supports .md, .canvas, .json, .css, etc.). Does NOT modify the vault immediately; creates a staged ChangeOperation for user review and approval.',
		schema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Target file path with extension (e.g. "Research/KV Cache.md", "Untitled.canvas"). Defaults to .md if no extension given.',
				},
				content: {
					type: 'string',
					description: 'Markdown content for the new note',
				},
			},
			required: ['path', 'content'],
		},
		execute: async (
			input: CreateNoteInput,
			ctx?: ToolContext,
		): Promise<Record<string, unknown>> => {
			const path = typeof input?.path === 'string' ? input.path : '';
			const content =
				typeof input?.content === 'string' ? input.content : '';
			const baseMtime = ctx?.getReadMtime?.(path);

			const changeSet = staging.stage({
				type: 'create',
				path,
				content,
				baseMtime,
			});

			if (ctx?.recordContext) {
				ctx.recordContext({
					path,
					reason: 'Staged create',
				});
			}

			return {
				staged: true,
				changeSetId: changeSet.id,
				operation: {
					type: 'create',
					path,
				},
				message: `Staged creation of "${path}". Operation is queued for user review and approval.`,
			};
		},
	};
}

export interface PatchNoteInput {
	path: string;
	heading: string;
	content: string;
}

export function createPatchNoteTool(
	staging: ChangeStagingManager,
): Tool<PatchNoteInput, Record<string, unknown>> {
	return {
		name: 'patch_note',
		description:
			'Stage an update to a specific heading section in an existing note. Does NOT modify the vault immediately; creates a staged ChangeOperation for user review and approval.',
		schema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Vault path to the note (e.g. "llama.cpp.md")',
				},
				heading: {
					type: 'string',
					description: 'The heading section to patch (e.g. "Memory Usage")',
				},
				content: {
					type: 'string',
					description: 'New markdown content for this section',
				},
			},
			required: ['path', 'heading', 'content'],
		},
		execute: async (
			input: PatchNoteInput,
			ctx?: ToolContext,
		): Promise<Record<string, unknown>> => {
			const path = typeof input?.path === 'string' ? input.path : '';
			const heading =
				typeof input?.heading === 'string' ? input.heading : '';
			const content =
				typeof input?.content === 'string' ? input.content : '';
			const baseMtime = ctx?.getReadMtime?.(path);

			const changeSet = staging.stage({
				type: 'patch-section',
				path,
				heading,
				content,
				baseMtime,
			});

			if (ctx?.recordContext) {
				ctx.recordContext({
					path,
					heading,
					reason: 'Staged patch',
				});
			}

			return {
				staged: true,
				changeSetId: changeSet.id,
				operation: {
					type: 'patch-section',
					path,
					heading,
				},
				message: `Staged patch for "${path}" under heading "${heading}". Operation is queued for user review and approval.`,
			};
		},
	};
}

export interface EditNoteInput {
	path: string;
	content: string;
}

export function createEditNoteTool(
	staging: ChangeStagingManager,
): Tool<EditNoteInput, Record<string, unknown>> {
	return {
		name: 'edit_note',
		description:
			'Stage an update/replacement of an entire existing file in the vault (supports .md, .canvas, .json, .css, etc.). Does NOT modify the vault immediately; creates a staged ChangeOperation for user review and approval.',
		schema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Vault path to the existing file with extension (e.g. "llama.cpp.md", "Untitled.canvas")',
				},
				content: {
					type: 'string',
					description: 'Updated content for the file',
				},
			},
			required: ['path', 'content'],
		},
		execute: async (
			input: EditNoteInput,
			ctx?: ToolContext,
		): Promise<Record<string, unknown>> => {
			const path = typeof input?.path === 'string' ? input.path : '';
			const content =
				typeof input?.content === 'string' ? input.content : '';
			const baseMtime = ctx?.getReadMtime?.(path);

			const changeSet = staging.stage({
				type: 'edit',
				path,
				content,
				baseMtime,
			});

			if (ctx?.recordContext) {
				ctx.recordContext({
					path,
					reason: 'Staged edit',
				});
			}

			return {
				staged: true,
				changeSetId: changeSet.id,
				operation: {
					type: 'edit',
					path,
				},
				message: `Staged edit of "${path}". Operation is queued for user review and approval.`,
			};
		},
	};
}






