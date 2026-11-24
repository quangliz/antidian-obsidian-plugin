import type { ChangeOperation, ChangeSet } from '../types/changes';
import type {
	NoteContent,
	NoteOutline,
	ReadNoteParams,
	VaultService,
} from '../types/vault';
import type { ChangeStagingManager } from './index';
import {
	applyAppend,
	applyBlockReplace,
	applyFrontmatterUpdate,
	applySectionPatch,
	extractMarkdownHeadings,
	extractSection,
	parseSimpleFrontmatter,
} from './markdown';

export type ApplyOperationResult =
	| { ok: true; content: string }
	| {
			ok: false;
			code:
				| 'file_already_exists'
				| 'file_not_found'
				| 'heading_not_found'
				| 'target_not_found'
				| 'ambiguous_match'
				| 'invalid_content';
			message: string;
	  };

/**
 * Purely applies a single ChangeOperation onto an existing file's content (or null if it does not exist yet).
 */
export function applyOperationToContent(
	currentContent: string | null,
	op: ChangeOperation,
): ApplyOperationResult {
	switch (op.type) {
		case 'create': {
			if (currentContent !== null) {
				return {
					ok: false,
					code: 'file_already_exists',
					message: `Cannot create note because file already exists: "${op.path}"`,
				};
			}
			if (typeof op.content !== 'string') {
				return {
					ok: false,
					code: 'invalid_content',
					message: `Content must be a valid string for "${op.path}"`,
				};
			}
			return { ok: true, content: op.content };
		}

		case 'edit': {
			if (currentContent === null) {
				return {
					ok: false,
					code: 'file_not_found',
					message: `Target note does not exist for edit: "${op.path}"`,
				};
			}
			if (typeof op.content !== 'string') {
				return {
					ok: false,
					code: 'invalid_content',
					message: `Content must be a valid string for "${op.path}"`,
				};
			}
			return { ok: true, content: op.content };
		}

		case 'patch-section': {
			if (currentContent === null) {
				return {
					ok: false,
					code: 'file_not_found',
					message: `Target note does not exist: "${op.path}"`,
				};
			}
			if (typeof op.content !== 'string') {
				return {
					ok: false,
					code: 'invalid_content',
					message: `Content must be a valid string for "${op.path}"`,
				};
			}
			const existingSection = extractSection(currentContent, op.heading);
			if (existingSection === null) {
				return {
					ok: false,
					code: 'heading_not_found',
					message: `Heading "${op.heading}" not found in note "${op.path}"`,
				};
			}
			return {
				ok: true,
				content: applySectionPatch(
					currentContent,
					op.heading,
					op.content,
				),
			};
		}

		case 'replace-block': {
			if (currentContent === null) {
				return {
					ok: false,
					code: 'file_not_found',
					message: `Target note does not exist for replace-block: "${op.path}"`,
				};
			}
			if (
				typeof op.oldText !== 'string' ||
				typeof op.newText !== 'string'
			) {
				return {
					ok: false,
					code: 'invalid_content',
					message: `oldText and newText must be strings for "${op.path}"`,
				};
			}
			const res = applyBlockReplace(
				currentContent,
				op.oldText,
				op.newText,
			);
			if (!res.ok) {
				if (res.reason === 'ambiguous') {
					return {
						ok: false,
						code: 'ambiguous_match',
						message: `oldText matched multiple locations in "${op.path}". Provide more surrounding context.`,
					};
				}
				return {
					ok: false,
					code: 'target_not_found',
					message: `oldText was not found in "${op.path}".`,
				};
			}
			return { ok: true, content: res.content };
		}

		case 'append': {
			if (currentContent === null) {
				return {
					ok: false,
					code: 'file_not_found',
					message: `Target note does not exist for append: "${op.path}"`,
				};
			}
			if (typeof op.content !== 'string') {
				return {
					ok: false,
					code: 'invalid_content',
					message: `Content must be a valid string for "${op.path}"`,
				};
			}
			const res = applyAppend(currentContent, op.content, op.heading);
			if (!res.ok) {
				return {
					ok: false,
					code: 'heading_not_found',
					message: `Heading "${op.heading ?? ''}" not found in note "${op.path}"`,
				};
			}
			return { ok: true, content: res.content };
		}

		case 'update-frontmatter': {
			if (currentContent === null) {
				return {
					ok: false,
					code: 'file_not_found',
					message: `Target note does not exist for frontmatter update: "${op.path}"`,
				};
			}
			const hasSet = Boolean(op.set && Object.keys(op.set).length > 0);
			const hasRemove = Boolean(op.remove && op.remove.length > 0);
			if (!hasSet && !hasRemove) {
				return {
					ok: false,
					code: 'invalid_content',
					message: `update-frontmatter for "${op.path}" must specify at least one key in "set" or "remove".`,
				};
			}
			return {
				ok: true,
				content: applyFrontmatterUpdate(
					currentContent,
					op.set,
					op.remove,
				),
			};
		}
	}
}

/**
 * Provides an overlay view of vault notes that includes pending staged operations
 * from the active ChangeSet so multi-step agent turns see their own edits immediately.
 */
export class StagedVaultOverlay {
	private vaultService: VaultService;
	private stagingManager: ChangeStagingManager;

	constructor(
		vaultService: VaultService,
		stagingManager: ChangeStagingManager,
	) {
		this.vaultService = vaultService;
		this.stagingManager = stagingManager;
	}

	private getPendingOpsForPath(
		normPath: string,
		changeSet?: ChangeSet | null,
	): ChangeOperation[] {
		const active = changeSet ?? this.stagingManager.getActive();
		if (!active || active.status !== 'staged') return [];

		return active.operations.filter(
			(op) => this.vaultService.normalizePath(op.path) === normPath,
		);
	}

	async readEffectiveNote(
		params: ReadNoteParams,
	): Promise<NoteContent | null> {
		const rawPath = params.path.trim();
		if (!rawPath) return null;

		const normPath = this.vaultService.normalizePath(rawPath);
		const diskNote = await this.vaultService.readNote({ path: rawPath });
		const canonicalPath = diskNote?.path ?? normPath;
		const pendingOps = this.getPendingOpsForPath(canonicalPath);

		if (pendingOps.length === 0) {
			return await this.vaultService.readNote(params);
		}

		let virtualContent: string | null = diskNote?.content ?? null;
		for (const op of pendingOps) {
			const applied = applyOperationToContent(virtualContent, op);
			if (applied.ok) {
				virtualContent = applied.content;
			}
		}

		if (virtualContent === null) return null;

		if (params.heading) {
			const section = extractSection(virtualContent, params.heading);
			return {
				path: canonicalPath,
				heading: params.heading,
				content: section ?? virtualContent,
				mtime: diskNote?.mtime,
				isStaged: true,
			};
		}

		return {
			path: canonicalPath,
			content: virtualContent,
			mtime: diskNote?.mtime,
			isStaged: true,
		};
	}

	async getEffectiveOutline(path: string): Promise<NoteOutline | null> {
		const rawPath = path.trim();
		if (!rawPath) return null;

		const normPath = this.vaultService.normalizePath(rawPath);
		const diskOutline = this.vaultService.getNoteOutline
			? await this.vaultService.getNoteOutline(rawPath)
			: null;
		const canonicalPath = diskOutline?.path ?? normPath;
		const pendingOps = this.getPendingOpsForPath(canonicalPath);

		if (pendingOps.length === 0 && diskOutline) {
			return diskOutline;
		}

		const effective = await this.readEffectiveNote({ path: rawPath });
		if (!effective) return diskOutline;

		const headings = extractMarkdownHeadings(effective.content).map(
			(h) => ({
				heading: h.heading,
				level: h.level,
				line: h.line,
			}),
		);
		const frontmatter = parseSimpleFrontmatter(effective.content);

		// Extract wikilinks and inline tags from virtual content
		const linkMatches = effective.content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g);
		const outgoingLinks = Array.from(
			new Set(Array.from(linkMatches, (m) => (m[1] ?? '').trim()).filter(Boolean)),
		);

		const inlineTagMatches = effective.content.matchAll(/(?:^|\s)(#[A-Za-z0-9_/-]+)/g);
		const tagSet = new Set<string>(
			Array.from(inlineTagMatches, (m) => m[1] ?? '').filter(Boolean),
		);
		const fmTags = frontmatter?.tags;
		if (Array.isArray(fmTags)) {
			for (const t of fmTags) {
				if (typeof t === 'string' && t.trim()) {
					tagSet.add(t.startsWith('#') ? t : `#${t}`);
				}
			}
		}

		return {
			path: effective.path,
			headings,
			frontmatter,
			tags: Array.from(tagSet),
			outgoingLinks,
			backlinks: diskOutline?.backlinks ?? [],
			mtime: effective.mtime,
			charCount: effective.content.length,
			isStaged: pendingOps.length > 0,
		};
	}
}
