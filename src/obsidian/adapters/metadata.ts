import { CachedMetadata, MetadataCache, TFile } from 'obsidian';

export class ObsidianMetadataAdapter {
	private cache: MetadataCache;

	constructor(cache: MetadataCache) {
		this.cache = cache;
	}

	getFileCache(file: TFile): CachedMetadata | null {
		return this.cache.getFileCache(file);
	}

	getFirstLinkpathDest(linkpath: string, defaultPath = ''): TFile | null {
		return this.cache.getFirstLinkpathDest(linkpath, defaultPath);
	}

	getBacklinks(targetPath: string): string[] {
		const backlinks: string[] = [];
		const resolved = this.cache.resolvedLinks;
		for (const [sourcePath, targets] of Object.entries(resolved)) {
			if (targets && Object.prototype.hasOwnProperty.call(targets, targetPath)) {
				backlinks.push(sourcePath);
			}
		}
		backlinks.sort();
		return backlinks;
	}
}
