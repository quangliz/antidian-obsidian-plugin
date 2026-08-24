import {
	VaultService,
	SearchResult,
	SearchNotesParams,
	ReadNoteParams,
	NoteContent,
} from '../types/vault';
import { ActiveContext, ContextReference } from '../types/context';
import { ChangeStagingManager } from '../transactions';
import { httpRequest } from '../models/http';
import {
	getAccessToken,
	discoverProject,
	CLOUD_CODE_ENDPOINTS,
	USER_AGENT,
} from '../models/antigravity-oauth';

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
			'Stage the creation of a new note in the vault. Does NOT modify the vault immediately; creates a staged ChangeOperation for user review and approval.',
		schema: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Target note path (e.g. "Research/KV Cache.md")',
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

export interface WebSearchParams {
	query: string;
}

export interface WebSearchResult {
	summary: string;
	sources: {
		title: string;
		url: string;
	}[];
}

async function queryAntigravityGrounding(
	prompt: string,
): Promise<{ text: string; sources: { title: string; url: string }[] }> {
	const accessToken = await getAccessToken();
	const project = await discoverProject(accessToken);

	const body = {
		model: 'gemini-2.5-flash',
		project,
		request: {
			contents: [
				{
					role: 'user',
					parts: [{ text: prompt }],
				},
			],
			tools: [{ googleSearch: {} }],
		},
	};

	const headers = {
		Authorization: `Bearer ${accessToken}`,
		'Content-Type': 'application/json',
		'User-Agent': USER_AGENT,
		Accept: 'text/event-stream',
	};

	let rawSSE = '';
	let lastError: string | null = null;
	for (const endpoint of CLOUD_CODE_ENDPOINTS) {
		try {
			const res = await httpRequest(
				`${endpoint}/v1internal:streamGenerateContent?alt=sse`,
				{
					method: 'POST',
					headers,
					body: JSON.stringify(body),
				},
			);

			if (res.statusCode >= 200 && res.statusCode < 300) {
				rawSSE = res.body;
				break;
			} else {
				lastError = `${res.statusCode}: ${res.body}`;
			}
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
	}

	if (!rawSSE) {
		throw new Error(
			`Antigravity grounding failed: ${lastError ?? 'unknown error'}`,
		);
	}

	let text = '';
	const sources: { title: string; url: string }[] = [];
	const seenUrls = new Set<string>();

	for (const line of rawSSE.split('\n')) {
		if (!line.startsWith('data:')) continue;
		const raw = line.slice(5).trim();
		if (!raw || raw === '[DONE]') continue;

		try {
			const event = JSON.parse(raw) as {
				response?: {
					candidates?: {
						content?: {
							parts?: { text?: string }[];
						};
						groundingMetadata?: {
							groundingChunks?: {
								web?: {
									uri?: string;
									title?: string;
								};
							}[];
						};
					}[];
				};
			};

			const candidate = event.response?.candidates?.[0];
			if (candidate?.content?.parts) {
				for (const part of candidate.content.parts) {
					if (part.text) {
						text += part.text;
					}
				}
			}

			const chunks =
				candidate?.groundingMetadata?.groundingChunks || [];
			for (const chunk of chunks) {
				const uri = chunk.web?.uri;
				if (uri && !seenUrls.has(uri)) {
					seenUrls.add(uri);
					sources.push({
						title: chunk.web?.title || uri,
						url: uri,
					});
				}
			}
		} catch {
			continue;
		}
	}

	return { text: text.trim(), sources };
}

export function createWebSearchTool(): Tool<
	WebSearchParams,
	WebSearchResult
> {
	return {
		name: 'web_search',
		description:
			'Search the live web or fetch and extract content from a specific URL using Google Search via the Antigravity endpoint. Returns grounded answers, page content, real-time facts, and source citations.',
		schema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description:
						'The search query, keywords, or specific HTTP/HTTPS URL to read',
				},
			},
			required: ['query'],
		},
		execute: async (
			input: WebSearchParams,
			ctx?: ToolContext,
		): Promise<WebSearchResult> => {
			const query =
				typeof input?.query === 'string' ? input.query.trim() : '';
			if (!query) {
				return { summary: 'No search query provided.', sources: [] };
			}

			const isUrl = /^https?:\/\//i.test(query);
			const prompt = isUrl
				? `Read and fetch the exact page content and details from this URL: ${query}\nExtract the main text, full documentation, and key information.`
				: `Search the web and provide concise, accurate information with facts for: ${query}`;

			const res = await queryAntigravityGrounding(prompt);

			if (ctx?.recordContext) {
				if (isUrl) {
					ctx.recordContext({
						path: query,
						reason: 'Fetched URL (Antigravity)',
					});
				}
				for (const src of res.sources) {
					if (src.url !== query) {
						ctx.recordContext({
							path: src.title || src.url,
							reason: 'Google Search (Antigravity)',
						});
					}
				}
			}

			return {
				summary: res.text || 'No information found.',
				sources: res.sources,
			};
		},
	};
}




