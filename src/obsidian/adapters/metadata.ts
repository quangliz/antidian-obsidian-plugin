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
}
