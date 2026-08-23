import { App, TFile } from 'obsidian';
import {
	VaultService,
	SearchNotesParams,
	ReadNoteParams,
	VaultSearchResult,
	VaultSearchMatch,
	NoteContent,
} from '../core/vault';

export class ObsidianVaultService implements VaultService {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	async searchNotes(
		params: SearchNotesParams,
	): Promise<VaultSearchResult[]> {
		const query = params.query.trim().toLowerCase();
		if (!query) {
			return [];
		}

		const terms = query.split(/\s+/).filter(Boolean);
		const limit = params.limit ?? 10;
		const files = this.app.vault.getMarkdownFiles();
		const results: VaultSearchResult[] = [];

		for (const file of files) {
			let score = 0;
			const matches: VaultSearchMatch[] = [];
			const baseLower = file.basename.toLowerCase();
			const pathLower = file.path.toLowerCase();

			if (baseLower === query) {
				score += 25;
			} else if (baseLower.includes(query)) {
				score += 15;
			} else {
				for (const term of terms) {
					if (baseLower.includes(term)) {
						score += 5;
					} else if (pathLower.includes(term)) {
						score += 2;
					}
				}
			}

			const cache = this.app.metadataCache.getFileCache(file);

			if (cache?.headings) {
				for (const h of cache.headings) {
					const hLower = h.heading.toLowerCase();
					if (
						hLower.includes(query) ||
						terms.some((t) => hLower.includes(t))
					) {
						score += 6;
						if (matches.length < 5) {
							matches.push({
								heading: h.heading,
								snippet: h.heading,
							});
						}
					}
				}
			}

			if (cache?.links) {
				for (const link of cache.links) {
					const lLower = link.link.toLowerCase();
					if (terms.some((t) => lLower.includes(t))) {
						score += 3;
					}
				}
			}

			const content = await this.app.vault.cachedRead(file);
			const contentLower = content.toLowerCase();

			for (const term of terms) {
				let index = contentLower.indexOf(term);
				let count = 0;

				while (index !== -1 && count < 3) {
					score += 1;
					count++;

					if (matches.length < 5) {
						const start = Math.max(0, index - 40);
						const end = Math.min(
							content.length,
							index + term.length + 60,
						);
						let snippet = content.slice(start, end).replace(/\n+/g, ' ').trim();
						if (start > 0) snippet = '...' + snippet;
						if (end < content.length) snippet = snippet + '...';

						const enclosingHeading = this.findHeadingForOffset(
							cache?.headings,
							index,
						);

						matches.push({
							heading: enclosingHeading,
							snippet,
						});
					}

					index = contentLower.indexOf(term, index + term.length);
				}
			}

			if (score > 0 || matches.length > 0) {
				results.push({
					path: file.path,
					score,
					matches,
				});
			}
		}

		results.sort((a, b) => b.score - a.score);
		return results.slice(0, limit);
	}

	async readNote(params: ReadNoteParams): Promise<NoteContent | null> {
		const targetPath = params.path.trim();
		if (!targetPath) {
			return null;
		}

		let file = this.app.vault.getAbstractFileByPath(targetPath);
		if (!(file instanceof TFile)) {
			file = this.app.metadataCache.getFirstLinkpathDest(targetPath, '');
		}

		if (!(file instanceof TFile)) {
			return null;
		}

		const content = await this.app.vault.cachedRead(file);

		if (!params.heading) {
			return {
				path: file.path,
				content,
			};
		}

		const targetHeading = params.heading
			.trim()
			.toLowerCase()
			.replace(/^#+\s*/, '');
		const cache = this.app.metadataCache.getFileCache(file);

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
				};
			}
		}

		return {
			path: file.path,
			heading: params.heading,
			content,
		};
	}

	private findHeadingForOffset(
		headings: { heading: string; position: { start: { offset: number } } }[] | undefined,
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
}
