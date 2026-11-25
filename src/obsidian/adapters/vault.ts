import { App, TFile, arrayBufferToBase64, normalizePath as obsNormalizePath } from 'obsidian';
import {
	VaultService,
	SearchNotesParams,
	ReadNoteParams,
	SearchResult,
	NoteContent,
	BinaryContent,
	ListNotesParams,
	NoteListItem,
	NoteOutline,
} from '../../core/types/vault';
import {
	AppliedChangeSet,
	AppliedOperation,
	ChangeSet,
	ChangeSetSnapshot,
	FileSnapshot,
	MutationService,
	RollbackResult,
} from '../../core/types/changes';
import { MAX_BINARY_READ_BYTES, binaryMimeForPath } from '../../core/files';
import { applyOperationToContent } from '../../core/transactions/overlay';
import { ObsidianMetadataAdapter } from './metadata';

export class ObsidianVaultAdapter implements VaultService, MutationService {
	private app: App;
	private metadataAdapter: ObsidianMetadataAdapter;

	constructor(app: App) {
		this.app = app;
		this.metadataAdapter = new ObsidianMetadataAdapter(app.metadataCache);
	}

	normalizePath(rawPath: string): string {
		let p = rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
		// Only default to .md when there is no file extension at all
		const basename = p.split('/').pop() || '';
		if (!basename.includes('.')) {
			p += '.md';
		}
		return obsNormalizePath(p);
	}

	isPathWithinVault(rawPath: string): boolean {
		const p = rawPath.trim().replace(/\\/g, '/');
		if (
			!p ||
			p.includes('\0') ||
			p.includes('..') ||
			p.startsWith('/') ||
			p.includes('://') ||
			/^[A-Za-z]:/.test(p)
		) {
			return false;
		}
		const configDirLower = this.app.vault.configDir
			.replace(/^\/+|\/+$/g, '')
			.toLowerCase();
		const segments = p.split('/').filter(Boolean);
		for (const seg of segments) {
			const lower = seg.toLowerCase();
			if (lower === configDirLower || lower === '.git') {
				return false;
			}
		}
		return true;
	}

	async fileExists(path: string): Promise<boolean> {
		const norm = this.normalizePath(path);
		const file = this.app.vault.getAbstractFileByPath(norm);
		if (file instanceof TFile) return true;
		const fallback = this.metadataAdapter.getFirstLinkpathDest(path, '');
		return fallback instanceof TFile;
	}

	async getFileMtime(path: string): Promise<number | null> {
		const norm = this.normalizePath(path);
		let file = this.app.vault.getAbstractFileByPath(norm);
		if (!(file instanceof TFile)) {
			file = this.metadataAdapter.getFirstLinkpathDest(path, '');
		}
		return file instanceof TFile ? file.stat.mtime : null;
	}

	async headingExists(path: string, heading: string): Promise<boolean> {
		const norm = this.normalizePath(path);
		let file = this.app.vault.getAbstractFileByPath(norm);
		if (!(file instanceof TFile)) {
			file = this.metadataAdapter.getFirstLinkpathDest(path, '');
		}
		if (!(file instanceof TFile)) return false;

		const cache = this.metadataAdapter.getFileCache(file);
		if (!cache?.headings || cache.headings.length === 0) return false;

		const cleanTarget = heading.trim().toLowerCase().replace(/^#+\s*/, '');
		return cache.headings.some(
			(h) => h.heading.trim().toLowerCase() === cleanTarget,
		);
	}

	async searchNotes(params: SearchNotesParams): Promise<SearchResult[]> {
		const query = params.query.trim().toLowerCase();
		if (!query) {
			return [];
		}

		const terms = query.split(/\s+/).filter(Boolean);
		const limit = params.limit ?? 10;
		const files = this.app.vault.getFiles();
		const allResults: SearchResult[] = [];

		for (const file of files) {
			const baseLower = file.basename.toLowerCase();
			const pathLower = file.path.toLowerCase();
			const cache = this.metadataAdapter.getFileCache(file);

			// 1. Title / Path Match
			if (baseLower === query) {
				allResults.push({
					path: file.path,
					score: 30,
					matchType: 'title',
					snippet: file.basename,
				});
			} else if (baseLower.includes(query)) {
				allResults.push({
					path: file.path,
					score: 20,
					matchType: 'title',
					snippet: file.basename,
				});
			} else {
				const titleMatches = terms.filter((t) =>
					baseLower.includes(t),
				).length;
				if (titleMatches > 0) {
					allResults.push({
						path: file.path,
						score: 10 + titleMatches * 3,
						matchType: 'title',
						snippet: file.basename,
					});
				} else if (terms.some((t) => pathLower.includes(t))) {
					allResults.push({
						path: file.path,
						score: 8,
						matchType: 'title',
						snippet: file.path,
					});
				}
			}

			// 2. Headings Match
			if (cache?.headings) {
				for (const h of cache.headings) {
					const hLower = h.heading.toLowerCase();
					if (hLower === query) {
						allResults.push({
							path: file.path,
							heading: h.heading,
							score: 25,
							matchType: 'heading',
							snippet: h.heading,
						});
					} else if (hLower.includes(query)) {
						allResults.push({
							path: file.path,
							heading: h.heading,
							score: 18,
							matchType: 'heading',
							snippet: h.heading,
						});
					} else {
						const hMatches = terms.filter((t) =>
							hLower.includes(t),
						).length;
						if (hMatches > 0) {
							allResults.push({
								path: file.path,
								heading: h.heading,
								score: 12 + hMatches * 2,
								matchType: 'heading',
								snippet: h.heading,
							});
						}
					}
				}
			}

			// 3. Properties / Tags / Frontmatter Match
			if (cache?.tags) {
				for (const t of cache.tags) {
					const tLower = t.tag.toLowerCase();
					if (
						tLower.includes(query) ||
						terms.some((term) => tLower.includes(term))
					) {
						allResults.push({
							path: file.path,
							score: 14,
							matchType: 'property',
							snippet: `tag: ${t.tag}`,
						});
					}
				}
			}

			if (cache?.frontmatter) {
				for (const [k, v] of Object.entries(cache.frontmatter)) {
					if (k === 'position') continue;
					const strVal = String(v ?? '');
					const strValLower = strVal.toLowerCase();
					const kLower = k.toLowerCase();

					if (
						kLower.includes(query) ||
						strValLower.includes(query) ||
						terms.some((term) => strValLower.includes(term))
					) {
						allResults.push({
							path: file.path,
							score: 12,
							matchType: 'property',
							snippet: `${k}: ${strVal}`,
						});
					}
				}
			}

			// 4. Links Match
			if (cache?.links) {
				for (const link of cache.links) {
					const lLower = link.link.toLowerCase();
					if (
						lLower.includes(query) ||
						terms.some((t) => lLower.includes(t))
					) {
						const enclosingHeading = this.findHeadingForOffset(
							cache?.headings,
							link.position.start.offset,
						);
						allResults.push({
							path: file.path,
							heading: enclosingHeading,
							score: 10,
							matchType: 'link',
							snippet: `[[${link.link}]]`,
						});
					}
				}
			}

			// 5. Body text search (other file types are found by name only)
			if (file.extension !== 'md') continue;
			const content = await this.app.vault.cachedRead(file);
			const contentLower = content.toLowerCase();

			for (const term of terms) {
				let index = contentLower.indexOf(term);
				let count = 0;

				while (index !== -1 && count < 2) {
					count++;

					const start = Math.max(0, index - 40);
					const end = Math.min(
						content.length,
						index + term.length + 60,
					);
					let snippet = content
						.slice(start, end)
						.replace(/\n+/g, ' ')
						.trim();
					if (start > 0) snippet = '...' + snippet;
					if (end < content.length) snippet = snippet + '...';

					const enclosingHeading = this.findHeadingForOffset(
						cache?.headings,
						index,
					);

					allResults.push({
						path: file.path,
						heading: enclosingHeading,
						score: 8,
						matchType: 'text',
						snippet,
					});

					index = contentLower.indexOf(term, index + term.length);
				}
			}
		}

		allResults.sort((a, b) => b.score - a.score);
		return allResults.slice(0, limit);
	}

	async readNote(params: ReadNoteParams): Promise<NoteContent | null> {
		const targetPath = params.path.trim();
		if (!targetPath) {
			return null;
		}

		let file = this.app.vault.getAbstractFileByPath(targetPath);
		if (!(file instanceof TFile)) {
			file = this.metadataAdapter.getFirstLinkpathDest(targetPath, '');
		}

		if (!(file instanceof TFile)) {
			return null;
		}

		const content = await this.app.vault.cachedRead(file);
		const mtime = file.stat.mtime;

		if (!params.heading) {
			return {
				path: file.path,
				content,
				mtime,
			};
		}

		const targetHeading = params.heading
			.trim()
			.toLowerCase()
			.replace(/^#+\s*/, '');
		const cache = this.metadataAdapter.getFileCache(file);

		if (cache?.headings && cache.headings.length > 0) {
			const targetItem = cache.headings.find(
				(h) => h.heading.trim().toLowerCase() === targetHeading,
			);

			if (targetItem) {
				const startOffset = targetItem.position.start.offset;
				const currentLevel = targetItem.level;
				let endOffset = content.length;

				const targetIdx = cache.headings.indexOf(targetItem);
				for (let j = targetIdx + 1; j < cache.headings.length; j++) {
					const nextItem = cache.headings[j];
					if (nextItem && nextItem.level <= currentLevel) {
						endOffset = nextItem.position.start.offset;
						break;
					}
				}

				return {
					path: file.path,
					heading: targetItem.heading,
					content: content.slice(startOffset, endOffset).trim(),
					mtime,
				};
			}
		}

		return {
			path: file.path,
			heading: params.heading,
			content,
			mtime,
		};
	}

	async readBinary(path: string): Promise<BinaryContent | null> {
		const targetPath = path.trim();
		if (!targetPath) return null;
		let file = this.app.vault.getAbstractFileByPath(targetPath);
		if (!(file instanceof TFile)) {
			file = this.metadataAdapter.getFirstLinkpathDest(targetPath, '');
		}
		if (!(file instanceof TFile)) return null;
		const mimeType = binaryMimeForPath(file.path);
		if (!mimeType) return null;
		if (file.stat.size > MAX_BINARY_READ_BYTES) {
			throw new Error(
				`"${file.path}" is too large to read (limit ${MAX_BINARY_READ_BYTES / 1024 / 1024} MB).`,
			);
		}
		return {
			path: file.path,
			mimeType,
			data: arrayBufferToBase64(await this.app.vault.readBinary(file)),
			size: file.stat.size,
			mtime: file.stat.mtime,
		};
	}

	async listNotes(params?: ListNotesParams): Promise<NoteListItem[]> {
		const folderFilter = params?.folder
			? params.folder.trim().replace(/^\/+|\/+$/g, '').toLowerCase()
			: '';
		const tagFilter = params?.tag
			? params.tag.trim().replace(/^#/, '').toLowerCase()
			: '';
		const sortBy = params?.sortBy ?? 'mtime';
		const limit = Math.min(Math.max(params?.limit ?? 50, 1), 200);

		const files = this.app.vault.getMarkdownFiles();
		const items: NoteListItem[] = [];

		for (const file of files) {
			if (folderFilter) {
				const pathLower = file.path.toLowerCase();
				if (
					!pathLower.startsWith(`${folderFilter}/`) &&
					pathLower !== folderFilter
				) {
					continue;
				}
			}

			const cache = this.metadataAdapter.getFileCache(file);
			const tagSet = new Set<string>();
			if (cache?.tags) {
				for (const t of cache.tags) {
					tagSet.add(t.tag.startsWith('#') ? t.tag : `#${t.tag}`);
				}
			}
			const fmTags: unknown = cache?.frontmatter?.tags;
			if (Array.isArray(fmTags)) {
				for (const t of fmTags) {
					if (typeof t === 'string' && t.trim()) {
						tagSet.add(t.startsWith('#') ? t : `#${t}`);
					}
				}
			} else if (typeof fmTags === 'string' && fmTags.trim()) {
				tagSet.add(fmTags.startsWith('#') ? fmTags : `#${fmTags}`);
			}

			const tags = Array.from(tagSet);
			if (tagFilter) {
				const matchesTag = tags.some((t) => {
					const clean = t.replace(/^#/, '').toLowerCase();
					return (
						clean === tagFilter ||
						clean.startsWith(`${tagFilter}/`)
					);
				});
				if (!matchesTag) continue;
			}

			items.push({
				path: file.path,
				basename: file.basename,
				mtime: file.stat.mtime,
				tags: tags.length > 0 ? tags : undefined,
			});
		}

		if (sortBy === 'name') {
			items.sort((a, b) => a.path.localeCompare(b.path));
		} else {
			items.sort((a, b) => b.mtime - a.mtime);
		}

		return items.slice(0, limit);
	}

	async getNoteOutline(path: string): Promise<NoteOutline | null> {
		const targetPath = path.trim();
		if (!targetPath) return null;

		let file = this.app.vault.getAbstractFileByPath(targetPath);
		if (!(file instanceof TFile)) {
			file = this.metadataAdapter.getFirstLinkpathDest(targetPath, '');
		}
		if (!(file instanceof TFile)) return null;

		const content = await this.app.vault.cachedRead(file);
		const cache = this.metadataAdapter.getFileCache(file);

		const headings = (cache?.headings ?? []).map((h) => ({
			heading: h.heading,
			level: h.level,
			line: h.position.start.line,
		}));

		let frontmatter: Record<string, unknown> | undefined;
		if (cache?.frontmatter) {
			const cleaned: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(cache.frontmatter)) {
				if (k !== 'position') {
					cleaned[k] = v;
				}
			}
			if (Object.keys(cleaned).length > 0) {
				frontmatter = cleaned;
			}
		}

		const tagSet = new Set<string>();
		for (const t of cache?.tags ?? []) {
			tagSet.add(t.tag.startsWith('#') ? t.tag : `#${t.tag}`);
		}
		const fmTags: unknown = frontmatter?.tags;
		if (Array.isArray(fmTags)) {
			for (const t of fmTags) {
				if (typeof t === 'string' && t.trim()) {
					tagSet.add(t.startsWith('#') ? t : `#${t}`);
				}
			}
		}

		const outgoingLinks = Array.from(
			new Set((cache?.links ?? []).map((l) => l.link)),
		);
		const backlinks = this.metadataAdapter.getBacklinks(file.path);

		return {
			path: file.path,
			headings,
			frontmatter,
			tags: Array.from(tagSet),
			outgoingLinks,
			backlinks,
			mtime: file.stat.mtime,
			charCount: content.length,
		};
	}

	async createNote(path: string, content: string): Promise<void> {
		const norm = this.normalizePath(path);
		const parts = norm.split('/');
		if (parts.length > 1) {
			const folderPath = parts.slice(0, -1).join('/');
			if (!this.app.vault.getAbstractFileByPath(folderPath)) {
				await this.app.vault.createFolder(folderPath);
			}
		}
		await this.app.vault.create(norm, content);
	}

	async patchSection(
		path: string,
		heading: string,
		newContent: string,
	): Promise<void> {
		const norm = this.normalizePath(path);
		let file = this.app.vault.getAbstractFileByPath(norm);
		if (!(file instanceof TFile)) {
			file = this.metadataAdapter.getFirstLinkpathDest(path, '');
		}
		if (!(file instanceof TFile)) {
			throw new Error(`File not found in vault: ${path}`);
		}

		const fullContent = await this.app.vault.read(file);
		const cache = this.metadataAdapter.getFileCache(file);
		const cleanTarget = heading.trim().toLowerCase().replace(/^#+\s*/, '');

		const targetItem = cache?.headings?.find(
			(h) => h.heading.trim().toLowerCase() === cleanTarget,
		);

		if (targetItem && cache?.headings) {
			const startOffset = targetItem.position.start.offset;
			const currentLevel = targetItem.level;
			let endOffset = fullContent.length;

			const targetIdx = cache.headings.indexOf(targetItem);
			for (let j = targetIdx + 1; j < cache.headings.length; j++) {
				const nextItem = cache.headings[j];
				if (nextItem && nextItem.level <= currentLevel) {
					endOffset = nextItem.position.start.offset;
					break;
				}
			}

			let replacement = newContent;
			if (!newContent.trim().startsWith('#')) {
				const hashes = '#'.repeat(targetItem.level);
				replacement = `${hashes} ${targetItem.heading}\n\n${newContent.trim()}\n\n`;
			} else {
				replacement = `${newContent.trim()}\n\n`;
			}

			const updated =
				fullContent.slice(0, startOffset) +
				replacement +
				fullContent.slice(endOffset).trimStart();

			await this.app.vault.modify(file, updated);
		} else {
			const toAppend = `\n\n## ${heading}\n\n${newContent.trim()}\n`;
			await this.app.vault.append(file, toAppend);
		}
	}

	private findHeadingForOffset(
		headings:
			| { heading: string; position: { start: { offset: number } } }[]
			| undefined,
		offset: number,
	): string | undefined {
		if (!headings || headings.length === 0) {
			return undefined;
		}

		let current: string | undefined;
		for (const h of headings) {
			if (h.position.start.offset <= offset) {
				current = h.heading;
			} else {
				break;
			}
		}
		return current;
	}

	async apply(changeSet: ChangeSet): Promise<AppliedChangeSet> {
		const appliedOps: AppliedOperation[] = [];

		for (const op of changeSet.operations) {
			let previousContent: string | undefined;

			if (op.type === 'create') {
				await this.createNote(op.path, op.content);
				appliedOps.push({
					operation: op,
					appliedAt: Date.now(),
					previousContent: undefined,
				});
			} else if (op.type === 'patch-section') {
				const existing = await this.readNote({
					path: op.path,
					heading: op.heading,
				});
				previousContent = existing?.content;
				await this.patchSection(op.path, op.heading, op.content);
				appliedOps.push({
					operation: op,
					appliedAt: Date.now(),
					previousContent,
				});
			} else if (op.type === 'edit') {
				const norm = this.normalizePath(op.path);
				let file = this.app.vault.getAbstractFileByPath(norm);
				if (!(file instanceof TFile)) {
					file = this.metadataAdapter.getFirstLinkpathDest(op.path, '');
				}
				if (file instanceof TFile) {
					previousContent = await this.app.vault.read(file);
					await this.app.vault.modify(file, op.content);
				} else {
					throw new Error(`File not found to edit: "${op.path}"`);
				}
				appliedOps.push({
					operation: op,
					appliedAt: Date.now(),
					previousContent,
				});
			} else if (
				op.type === 'replace-block' ||
				op.type === 'append' ||
				op.type === 'update-frontmatter'
			) {
				const norm = this.normalizePath(op.path);
				let file = this.app.vault.getAbstractFileByPath(norm);
				if (!(file instanceof TFile)) {
					file = this.metadataAdapter.getFirstLinkpathDest(op.path, '');
				}
				if (!(file instanceof TFile)) {
					throw new Error(`File not found for ${op.type}: "${op.path}"`);
				}
				previousContent = await this.app.vault.read(file);
				const next = applyOperationToContent(previousContent, op);
				if (!next.ok) {
					throw new Error(next.message);
				}
				await this.app.vault.modify(file, next.content);
				appliedOps.push({
					operation: op,
					appliedAt: Date.now(),
					previousContent,
				});
			}
		}

		changeSet.status = 'applied';

		return {
			id: changeSet.id,
			appliedAt: Date.now(),
			operations: appliedOps,
		};
	}

	async captureSnapshot(changeSet: ChangeSet): Promise<ChangeSetSnapshot> {
		const files: FileSnapshot[] = [];
		const seenPaths = new Set<string>();

		for (const op of changeSet.operations) {
			const norm = this.normalizePath(op.path);
			if (seenPaths.has(norm)) continue;
			seenPaths.add(norm);

			let file = this.app.vault.getAbstractFileByPath(norm);
			if (!(file instanceof TFile)) {
				file = this.metadataAdapter.getFirstLinkpathDest(op.path, '');
			}

			if (file instanceof TFile) {
				const content = await this.app.vault.read(file);
				files.push({
					path: file.path,
					content,
					existed: true,
				});
			} else {
				files.push({
					path: norm,
					content: undefined,
					existed: false,
				});
			}
		}

		return {
			changeSetId: changeSet.id,
			createdAt: Date.now(),
			files,
		};
	}

	async rollback(snapshot: ChangeSetSnapshot): Promise<RollbackResult> {
		const errors: string[] = [];
		let restoredCount = 0;

		for (const fileSnap of snapshot.files) {
			try {
				let file = this.app.vault.getAbstractFileByPath(fileSnap.path);
				if (!(file instanceof TFile)) {
					file = this.metadataAdapter.getFirstLinkpathDest(
						fileSnap.path,
						'',
					);
				}

				if (fileSnap.existed && fileSnap.content !== undefined) {
					if (file instanceof TFile) {
						await this.app.vault.modify(file, fileSnap.content);
					} else {
						await this.createNote(fileSnap.path, fileSnap.content);
					}
					restoredCount++;
				} else if (!fileSnap.existed && file instanceof TFile) {
					await this.app.fileManager.trashFile(file);
					restoredCount++;
				}
			} catch (err) {
				errors.push(
					`Failed to restore ${fileSnap.path}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		return {
			success: errors.length === 0,
			restoredCount,
			errors,
		};
	}
}
