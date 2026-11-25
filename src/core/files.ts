/** File-type facts shared by the read tools, write validation, and the prompt bar. */

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

/** Largest non-text file handed to the model. */
export const MAX_BINARY_READ_BYTES = 20 * 1024 * 1024;

function extensionOf(path: string): string {
	return /\.([^./\\]+)$/.exec(path.trim())?.[1]?.toLowerCase() ?? '';
}

/** MIME type for a file name or path by extension, if it is attachable media. */
export function mediaMimeForName(name: string): string | undefined {
	return MEDIA_TYPES_BY_EXTENSION[extensionOf(name)];
}

/**
 * MIME type of a non-text file the model can read, by extension. SVG is text:
 * it is read (and edited) as source.
 */
export function binaryMimeForPath(path: string): string | undefined {
	const ext = extensionOf(path);
	if (ext === 'svg') return undefined;
	return ext === 'pdf' ? 'application/pdf' : MEDIA_TYPES_BY_EXTENSION[ext];
}
