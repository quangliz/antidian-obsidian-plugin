import {
	VaultService,
	VaultSearchResult,
	NoteContent,
} from '../types/vault';

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export function createVaultTools(vaultService: VaultService): ToolDefinition[] {
	return [
		{
			name: 'search_notes',
			description:
				'Search vault notes by keywords matching titles, headings, wikilinks, and content.',
			parameters: {
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
				args: Record<string, unknown>,
			): Promise<VaultSearchResult[]> => {
				const query =
					typeof args.query === 'string' ? args.query : '';
				const limit =
					typeof args.limit === 'number' ? args.limit : undefined;
				return vaultService.searchNotes({ query, limit });
			},
		},
		{
			name: 'read_note',
			description:
				'Read the content of a note or a specific heading section in the vault.',
			parameters: {
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
				args: Record<string, unknown>,
			): Promise<NoteContent | null> => {
				const path = typeof args.path === 'string' ? args.path : '';
				const heading =
					typeof args.heading === 'string' ? args.heading : undefined;
				return vaultService.readNote({ path, heading });
			},
		},
	];
}
