import { extractOfficeText, isOfficeMime } from '../office';
import type {
	VaultService,
	SearchResult,
	SearchNotesParams,
	ReadNoteParams,
	NoteContent,
	BinaryContent,
	ListNotesParams,
	NoteListItem,
	NoteOutline,
} from '../types/vault';
import type { ActiveContext, ContextReference } from '../types/context';
import type { SkillDocument, SkillService, SkillSummary } from '../types/skills';
import type { ChangeStagingManager, StagedVaultOverlay } from '../transactions';

export type HarnessPermissionMode = 'ask' | 'plan' | 'auto';

export interface ToolContext {
	context?: ActiveContext;
	permissionMode?: HarnessPermissionMode;
	/** Aborted when the user cancels/interrupts the active turn. */
	signal?: AbortSignal;
	recordContext?: (ref: ContextReference) => void;
	recordReadMtime?: (path: string, mtime: number) => void;
	getReadMtime?: (path: string) => number | undefined;
	/**
	 * Per-call review of a staged mutation (human-in-the-loop in `ask` mode,
	 * automatic in `auto`). Receives the tool's output and returns the output
	 * the model should see instead.
	 */
	reviewMutation?: (call: MutationCall) => Promise<unknown>;
	[key: string]: unknown;
}

export interface MutationCall {
	callId: string;
	toolName: string;
	toolArgs: Record<string, unknown>;
	output: unknown;
}

export interface Tool<I = unknown, O = unknown> {
	name: string;
	description: string;
	schema: Record<string, unknown>;
	mutates?: boolean;
	execute(input: I, ctx?: ToolContext): Promise<O>;
}

/**
 * A tool result that carries a file. `info` is the JSON the model and the UI
 * see; the bytes go to the model as a separate MCP content block.
 */
export class FileToolResult {
	readonly info: Record<string, unknown>;
	readonly file: Pick<BinaryContent, 'path' | 'mimeType' | 'data'>;

	constructor(
		info: Record<string, unknown>,
		file: Pick<BinaryContent, 'path' | 'mimeType' | 'data'>,
	) {
		this.info = info;
		this.file = file;
	}
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

export function createListNotesTool(
	vaultService: VaultService,
): Tool<ListNotesParams, NoteListItem[]> {
	return {
		name: 'list_notes',
		description:
			'List markdown notes in the vault with optional folder prefix, tag filter, and sort order (mtime or name). Use this to explore vault organization before reading specific notes.',
		schema: {
			type: 'object',
			properties: {
				folder: {
					type: 'string',
					description:
						'Optional folder prefix to filter by (e.g. "Projects" or "Daily")',
				},
				tag: {
					type: 'string',
					description:
						'Optional tag filter without or with # (e.g. "research" or "#project")',
				},
				sortBy: {
					type: 'string',
					enum: ['mtime', 'name'],
					description:
						'Sort order: "mtime" (most recently modified first, default) or "name"',
				},
				limit: {
					type: 'number',
					description: 'Maximum notes to return (default 50, max 200)',
				},
			},
		},
		execute: async (input: ListNotesParams): Promise<NoteListItem[]> => {
			if (!vaultService.listNotes) {
				return [];
			}
			return await vaultService.listNotes({
				folder:
					typeof input?.folder === 'string' ? input.folder : undefined,
				tag: typeof input?.tag === 'string' ? input.tag : undefined,
				sortBy:
					input?.sortBy === 'name' || input?.sortBy === 'mtime'
						? input.sortBy
						: 'mtime',
				limit:
					typeof input?.limit === 'number' ? input.limit : undefined,
			});
		},
	};
}

export function createGetNoteOutlineTool(
	vaultService: VaultService,
	overlay?: StagedVaultOverlay,
): Tool<{ path: string }, NoteOutline | null> {
	return {
		name: 'get_note_outline',
		description:
			'Get lightweight structural metadata for a note: headings (with levels), YAML frontmatter properties, tags, outgoing wikilinks, backlinks, and character count. Prefer calling this before reading long notes in full.',
		schema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Vault path or note title (e.g. "Projects/Roadmap.md")',
				},
			},
			required: ['path'],
		},
		execute: async (
			input: { path: string },
			ctx?: ToolContext,
		): Promise<NoteOutline | null> => {
			const path = typeof input?.path === 'string' ? input.path : '';
			const outline = overlay
				? await overlay.getEffectiveOutline(path)
				: vaultService.getNoteOutline
					? await vaultService.getNoteOutline(path)
					: null;

			if (outline) {
				if (ctx?.recordContext) {
					ctx.recordContext({
						path: outline.path,
						reason: 'Note outline',
						chars: outline.charCount,
					});
				}
				if (outline.mtime && ctx?.recordReadMtime) {
					ctx.recordReadMtime(outline.path, outline.mtime);
				}
			}

			return outline;
		},
	};
}

export function createSearchNotesTool(
	vaultService: VaultService,
): Tool<SearchNotesParams, SearchResult[]> {
	return {
		name: 'search_notes',
		description:
			'Search vault notes and sections, plus other files (images, PDFs, …) by name. Returns structured matches with path, heading, matchType (title|heading|text|property|link), and snippet to pinpoint relevant sections before reading.',
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
	overlay?: StagedVaultOverlay,
): Tool<ReadNoteParams, NoteContent | FileToolResult | null> {
	return {
		name: 'read_note',
		description:
			'Read any vault file: a note (or one heading section of it), another text file (canvas, base, JSON, CSV, code, SVG source), an Office document (docx, xlsx, pptx), returned as its text, or another non-text file (image, PDF, audio, video), returned as the file itself. Automatically reflects any pending edits staged earlier in the current turn.',
		schema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description:
						'Vault path to the file (e.g. "llama.cpp.md", "Assets/diagram.png")',
				},
				heading: {
					type: 'string',
					description: 'Optional heading section to read (notes only)',
				},
			},
			required: ['path'],
		},
		execute: async (
			input: ReadNoteParams,
			ctx?: ToolContext,
		): Promise<NoteContent | FileToolResult | null> => {
			const path = typeof input?.path === 'string' ? input.path : '';
			const heading =
				typeof input?.heading === 'string' ? input.heading : undefined;

			const binary = await vaultService.readBinary?.(path);
			if (binary && isOfficeMime(binary.mimeType)) {
				ctx?.recordContext?.({ path: binary.path, reason: 'Read file' });
				try {
					const content = extractOfficeText(Buffer.from(binary.data, 'base64'), binary.mimeType);
					return { path: binary.path, content, mtime: binary.mtime };
				} catch (err) {
					throw new Error(
						`Could not read "${binary.path}": ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			if (binary) {
				ctx?.recordContext?.({ path: binary.path, reason: 'Read file' });
				return new FileToolResult(
					{
						path: binary.path,
						mimeType: binary.mimeType,
						size: binary.size,
						mtime: binary.mtime,
						message:
							'The file follows. If it was offloaded to a file instead, open that exact file with read_file to view it.',
					},
					binary,
				);
			}

			const note = overlay
				? await overlay.readEffectiveNote({ path, heading })
				: await vaultService.readNote({ path, heading });

			if (note?.content.includes('\0')) {
				throw new Error(`"${note.path}" is a binary file of an unsupported type.`);
			}

			if (note) {
				if (ctx?.recordContext) {
					ctx.recordContext({
						path: note.path,
						heading: note.heading,
						reason: note.isStaged ? 'Read note (staged)' : 'Read note',
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
		mutates: true,
		description:
			'Stage the creation of a new file in the vault (supports .md, .canvas, .json, .css, etc.). Does NOT modify the vault immediately; creates a staged ChangeOperation for user review and approval.',
		schema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description:
						'Target file path with extension (e.g. "Research/KV Cache.md", "Untitled.canvas"). Defaults to .md if no extension given.',
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
				// Identifies the staged op so it can be reviewed on its own.
				operationId: changeSet.operations[changeSet.operations.length - 1]?.id,
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
		mutates: true,
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
				// Identifies the staged op so it can be reviewed on its own.
				operationId: changeSet.operations[changeSet.operations.length - 1]?.id,
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

export interface ReplaceBlockInput {
	path: string;
	oldText: string;
	newText: string;
}

export function createReplaceBlockTool(
	staging: ChangeStagingManager,
): Tool<ReplaceBlockInput, Record<string, unknown>> {
	return {
		name: 'replace_block',
		mutates: true,
		description:
			'Stage a targeted exact-text replacement within an existing note. Preferred over edit_note for localized changes. oldText must match uniquely in the note.',
		schema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Vault path to the note',
				},
				oldText: {
					type: 'string',
					description:
						'Exact existing text to replace (must occur exactly once in the note)',
				},
				newText: {
					type: 'string',
					description: 'Replacement text',
				},
			},
			required: ['path', 'oldText', 'newText'],
		},
		execute: async (
			input: ReplaceBlockInput,
			ctx?: ToolContext,
		): Promise<Record<string, unknown>> => {
			const path = typeof input?.path === 'string' ? input.path : '';
			const oldText =
				typeof input?.oldText === 'string' ? input.oldText : '';
			const newText =
				typeof input?.newText === 'string' ? input.newText : '';
			const baseMtime = ctx?.getReadMtime?.(path);

			const changeSet = staging.stage({
				type: 'replace-block',
				path,
				oldText,
				newText,
				baseMtime,
			});

			if (ctx?.recordContext) {
				ctx.recordContext({
					path,
					reason: 'Staged block replace',
				});
			}

			return {
				staged: true,
				changeSetId: changeSet.id,
				// Identifies the staged op so it can be reviewed on its own.
				operationId: changeSet.operations[changeSet.operations.length - 1]?.id,
				operation: {
					type: 'replace-block',
					path,
				},
				message: `Staged targeted block replacement in "${path}". Operation is queued for user review and approval.`,
			};
		},
	};
}

export interface AppendNoteInput {
	path: string;
	content: string;
	heading?: string;
}

export function createAppendNoteTool(
	staging: ChangeStagingManager,
): Tool<AppendNoteInput, Record<string, unknown>> {
	return {
		name: 'append_note',
		mutates: true,
		description:
			'Stage appending new markdown content to the end of an existing note, or to the end of a specific heading section.',
		schema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Vault path to the note',
				},
				content: {
					type: 'string',
					description: 'Markdown content to append',
				},
				heading: {
					type: 'string',
					description:
						'Optional heading under which to append the content',
				},
			},
			required: ['path', 'content'],
		},
		execute: async (
			input: AppendNoteInput,
			ctx?: ToolContext,
		): Promise<Record<string, unknown>> => {
			const path = typeof input?.path === 'string' ? input.path : '';
			const content =
				typeof input?.content === 'string' ? input.content : '';
			const heading =
				typeof input?.heading === 'string' && input.heading.trim()
					? input.heading.trim()
					: undefined;
			const baseMtime = ctx?.getReadMtime?.(path);

			const changeSet = staging.stage({
				type: 'append',
				path,
				content,
				heading,
				baseMtime,
			});

			if (ctx?.recordContext) {
				ctx.recordContext({
					path,
					heading,
					reason: 'Staged append',
				});
			}

			return {
				staged: true,
				changeSetId: changeSet.id,
				// Identifies the staged op so it can be reviewed on its own.
				operationId: changeSet.operations[changeSet.operations.length - 1]?.id,
				operation: {
					type: 'append',
					path,
					heading,
				},
				message: heading
					? `Staged append to "${path}" under heading "${heading}".`
					: `Staged append to end of "${path}".`,
			};
		},
	};
}

export interface UpdateFrontmatterInput {
	path: string;
	set?: Record<string, unknown>;
	remove?: string[];
}

export function createUpdateFrontmatterTool(
	staging: ChangeStagingManager,
): Tool<UpdateFrontmatterInput, Record<string, unknown>> {
	return {
		name: 'update_frontmatter',
		mutates: true,
		description:
			'Stage setting or removing YAML frontmatter properties on a note without modifying its markdown body.',
		schema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Vault path to the note',
				},
				set: {
					type: 'object',
					description:
						'Key-value pairs to add or update in YAML frontmatter (supports strings, numbers, booleans, arrays)',
				},
				remove: {
					type: 'array',
					items: { type: 'string' },
					description: 'Frontmatter property keys to remove',
				},
			},
			required: ['path'],
		},
		execute: async (
			input: UpdateFrontmatterInput,
			ctx?: ToolContext,
		): Promise<Record<string, unknown>> => {
			const path = typeof input?.path === 'string' ? input.path : '';
			const set =
				input?.set && typeof input.set === 'object' && !Array.isArray(input.set)
					? input.set
					: undefined;
			const remove = Array.isArray(input?.remove)
				? input.remove.filter((k): k is string => typeof k === 'string')
				: undefined;
			const baseMtime = ctx?.getReadMtime?.(path);

			const changeSet = staging.stage({
				type: 'update-frontmatter',
				path,
				set,
				remove,
				baseMtime,
			});

			if (ctx?.recordContext) {
				ctx.recordContext({
					path,
					reason: 'Staged frontmatter update',
				});
			}

			return {
				staged: true,
				changeSetId: changeSet.id,
				// Identifies the staged op so it can be reviewed on its own.
				operationId: changeSet.operations[changeSet.operations.length - 1]?.id,
				operation: {
					type: 'update-frontmatter',
					path,
				},
				message: `Staged frontmatter update for "${path}". Operation is queued for user review and approval.`,
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
		mutates: true,
		description:
			'Stage a full-file replacement of an existing file in the vault (supports .md, .canvas, .json, .css, etc.). Prefer replace_block, patch_note, append_note, or update_frontmatter for localized markdown edits.',
		schema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description:
						'Vault path to the existing file with extension (e.g. "llama.cpp.md", "Untitled.canvas")',
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
				// Identifies the staged op so it can be reviewed on its own.
				operationId: changeSet.operations[changeSet.operations.length - 1]?.id,
				operation: {
					type: 'edit',
					path,
				},
				message: `Staged edit of "${path}". Operation is queued for user review and approval.`,
			};
		},
	};
}

export function createListSkillsTool(
	skillService: SkillService,
): Tool<Record<string, never>, SkillSummary[]> {
	return {
		name: 'list_skills',
		description:
			'List available vault workflow skills (from .anti-dian/skills/) with their names and descriptions.',
		schema: {
			type: 'object',
			properties: {},
		},
		execute: async (): Promise<SkillSummary[]> => {
			return await skillService.listSkills();
		},
	};
}

export function createLoadSkillTool(
	skillService: SkillService,
): Tool<{ name: string }, SkillDocument | { error: string }> {
	return {
		name: 'load_skill',
		description:
			'Load the full markdown instructions for a specific vault skill by name when it matches the user request.',
		schema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: 'Name of the vault skill to load',
				},
			},
			required: ['name'],
		},
		execute: async (
			input: { name: string },
			ctx?: ToolContext,
		): Promise<SkillDocument | { error: string }> => {
			const name = typeof input?.name === 'string' ? input.name.trim() : '';
			if (!name) {
				return { error: 'Skill name is required.' };
			}
			const doc = await skillService.loadSkill(name);
			if (!doc) {
				return { error: `Skill "${name}" not found in .anti-dian/skills/.` };
			}
			if (ctx?.recordContext) {
				ctx.recordContext({
					path: doc.path,
					reason: `Loaded skill (${doc.name})`,
					chars: doc.body.length,
				});
			}
			return doc;
		},
	};
}
