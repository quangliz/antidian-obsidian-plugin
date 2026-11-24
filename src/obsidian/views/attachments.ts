/**
 * Pure helpers for attaching media to a prompt (no Obsidian imports, so they are unit-testable).
 */

export type AttachmentKind = 'image' | 'video' | 'audio';

/** Upper bound for attached media files to prevent out-of-memory base64 reads. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** File extensions that can be attached as media, with their MIME types. */
export const MEDIA_TYPES_BY_EXTENSION: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	avif: 'image/avif',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
	ogv: 'video/ogg',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	m4a: 'audio/mp4',
	ogg: 'audio/ogg',
	flac: 'audio/flac',
};

export function isAttachableMime(mimeType: string): boolean {
	return /^(image|video|audio)\//.test(mimeType);
}

export function mediaKind(mimeType: string): AttachmentKind {
	return mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'image';
}

/** MIME type for a file name or path by extension, if it is attachable media. */
export function mediaMimeForName(name: string): string | undefined {
	const ext = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase();
	return ext ? MEDIA_TYPES_BY_EXTENSION[ext] : undefined;
}

/**
 * Local paths from clipboard text when it is only `file://` URIs (what Linux
 * file managers put on the clipboard on copy). Anything else returns [], so
 * ordinary text — including a single pasted URL among other text — pastes as text.
 */
export function parseFileUriList(text: string): string[] {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		// text/uri-list allows # comment lines.
		.filter((l) => l && !l.startsWith('#'));
	if (lines.length === 0 || !lines.every((l) => l.startsWith('file://'))) return [];
	const paths: string[] = [];
	for (const line of lines) {
		try {
			const url = new URL(line);
			let path = decodeURIComponent(url.pathname);
			// file:///C:/x on Windows → C:/x
			if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
			paths.push(path);
		} catch {
			return [];
		}
	}
	return paths;
}

/**
 * Absolute local paths from clipboard text: either `file://` URIs (see
 * `parseFileUriList`) or plain absolute paths, one per line, each with a media
 * extension. Linux file managers put the plain path in text/plain, which is
 * the only clipboard type Chromium exposes on paste. Returns [] for anything
 * else, so ordinary text pastes as text.
 */
export function parseClipboardFilePaths(text: string): string[] {
	const uris = parseFileUriList(text);
	if (uris.length > 0) return uris;
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) return [];
	const isAbsolute = (l: string) => l.startsWith('/') || /^[A-Za-z]:[\\/]/.test(l) || l.startsWith('\\\\');
	if (!lines.every((l) => isAbsolute(l) && mediaMimeForName(l) !== undefined)) return [];
	return lines;
}

/** Paths from GNOME's `x-special/gnome-copied-files` clipboard format ("copy\nfile://…"). */
export function parseGnomeCopiedFiles(text: string): string[] {
	const lines = text.split(/\r?\n/);
	if (lines[0] === 'copy' || lines[0] === 'cut') lines.shift();
	return parseFileUriList(lines.join('\n'));
}
