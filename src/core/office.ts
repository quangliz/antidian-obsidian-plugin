/** Text extraction for Word, Excel, and PowerPoint files (ZIP packages of XML parts). */

import { inflateRawSync } from 'zlib';

/** Total inflated bytes allowed per file, so a crafted package cannot exhaust memory. */
const MAX_INFLATED_BYTES = 100 * 1024 * 1024;

const OFFICE_MIME_PREFIX = 'application/vnd.openxmlformats-officedocument.';

type ReadPart = (name: string) => string | undefined;

/** Opens a ZIP archive and returns a reader for its UTF-8 entries. */
function openZip(bytes: Buffer): ReadPart {
	const end = bytes.lastIndexOf('PK\x05\x06', undefined, 'latin1');
	if (end < 0) throw new Error('not a ZIP package (it may be password-protected)');
	const entries = new Map<string, { method: number; size: number; offset: number }>();
	let at = bytes.readUInt32LE(end + 16);
	for (let i = bytes.readUInt16LE(end + 10); i > 0; i--) {
		const nameEnd = at + 46 + bytes.readUInt16LE(at + 28);
		entries.set(bytes.toString('utf8', at + 46, nameEnd), {
			method: bytes.readUInt16LE(at + 10),
			size: bytes.readUInt32LE(at + 20),
			offset: bytes.readUInt32LE(at + 42),
		});
		at = nameEnd + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
	}

	let budget = MAX_INFLATED_BYTES;
	return (name) => {
		const entry = entries.get(name);
		if (!entry) return undefined;
		const start =
			entry.offset +
			30 +
			bytes.readUInt16LE(entry.offset + 26) +
			bytes.readUInt16LE(entry.offset + 28);
		const raw = bytes.subarray(start, start + entry.size);
		if (budget <= 0) throw new Error('its contents are too large');
		const data = entry.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: budget });
		budget -= data.length;
		return data.toString('utf8');
	};
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
	return text.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(\w+));/gi, (all, hex, dec, name) => {
		if (name) return ENTITIES[name as string] ?? all;
		const code = hex ? parseInt(hex as string, 16) : Number(dec);
		return code <= 0x10ffff ? String.fromCodePoint(code) : all;
	});
}

function attr(attrs: string, name: string): string | undefined {
	const value = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
	return value ? decodeXml(value[1] ?? value[2] ?? '') : undefined;
}

/** Attribute strings of every `name` element, whatever its namespace prefix. */
function elements(xml: string, name: string): string[] {
	return Array.from(xml.matchAll(new RegExp(`<(?:\\w+:)?${name}(\\s[^>]*)?>`, 'g')), (m) => m[1] ?? '');
}

/** Relationship targets of a part ('' is the package itself), as package paths. */
function relationships(read: ReadPart, part: string): { id?: string; type: string; target: string }[] {
	const slash = part.lastIndexOf('/') + 1;
	const dir = part.slice(0, slash);
	const xml = read(`${dir}_rels/${part.slice(slash)}.rels`) ?? '';
	return elements(xml, 'Relationship').map((attrs) => {
		const target = attr(attrs, 'Target') ?? '';
		const path: string[] = [];
		for (const segment of (target.startsWith('/') ? target : dir + target).split('/')) {
			if (segment === '..') path.pop();
			else if (segment && segment !== '.') path.push(segment);
		}
		return { id: attr(attrs, 'Id'), type: attr(attrs, 'Type') ?? '', target: path.join('/') };
	});
}

/** Text of WordprocessingML (`w`) or DrawingML (`a`): paragraphs as lines, table cells tab-separated. */
function paragraphs(xml: string, ns: 'w' | 'a'): string {
	// Compatibility fallbacks repeat the text of the shape they stand in for.
	const source = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
	const tokens = new RegExp(
		`<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>|<(w:tab|w:br|w:cr|a:br)(?:\\s[^>]*)?/?>|</(${ns}:(?:p|tc|tr))>|<(w:tabs)>[\\s\\S]*?</w:tabs>`,
		'g',
	);
	let out = '';
	for (const [, text, inline, close] of source.matchAll(tokens)) {
		if (text !== undefined) out += decodeXml(text);
		else if (inline) out += inline.endsWith(':tab') ? '\t' : '\n';
		else if (close?.endsWith(':tc')) out = `${out.replace(/\n$/, '')}\t`;
		else if (close?.endsWith(':tr')) out = `${out.replace(/\t$/, '')}\n`;
		else if (close) out += '\n';
	}
	return out.replace(/\n{3,}/g, '\n\n').trim();
}

function slidesText(read: ReadPart, main: string, xml: string): string {
	const rels = relationships(read, main);
	return elements(xml, 'sldId')
		.map((attrs) => attr(attrs, '\\w+:id'))
		// Section lists repeat the slides without a relationship id.
		.filter((id) => id !== undefined)
		.map((id, i) => {
			const slide = rels.find((r) => r.id === id);
			return `# Slide ${i + 1}\n${paragraphs(read(slide?.target ?? '') ?? '', 'a')}`;
		})
		.join('\n\n');
}

/** Concatenated `t` runs of a shared or inline string, without phonetic guides. */
function richText(xml: string): string {
	const runs = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
	return Array.from(runs.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([^<]*)<\//g), (m) => decodeXml(m[1] ?? '')).join('');
}

/** For each cell style index, whether its number format shows a date or time. */
function dateStyles(xml: string): boolean[] {
	const custom = new Map(
		elements(xml, 'numFmt').map((a) => [
			Number(attr(a, 'numFmtId')),
			// Quoted text, escapes, and [Red]-style sections are not date codes.
			/[ymdhs]/i.test((attr(a, 'formatCode') ?? '').replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '')),
		]),
	);
	const xfs = /<(?:\w+:)?cellXfs\b[\s\S]*?<\/(?:\w+:)?cellXfs>/.exec(xml)?.[0] ?? '';
	return elements(xfs, 'xf').map((a) => {
		const id = Number(attr(a, 'numFmtId'));
		return custom.get(id) ?? ((id >= 14 && id <= 22) || (id >= 45 && id <= 47));
	});
}

/** Excel's day count as an ISO date, or a time of day when it has no date part. */
function serialDate(serial: number, date1904: boolean): string {
	const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86400) * 1000;
	const iso = Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined;
	if (!iso) return String(serial);
	const time = iso.slice(11, 19);
	if (serial >= 0 && serial < 1) return time;
	return time === '00:00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${time}`;
}

function sheetsText(read: ReadPart, main: string, xml: string): string {
	const rels = relationships(read, main);
	const part = (type: string) => read(rels.find((r) => r.type.endsWith(`/${type}`))?.target ?? '') ?? '';
	const strings = Array.from(
		part('sharedStrings').matchAll(/<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g),
		(m) => richText(m[1] ?? ''),
	);
	const isDate = dateStyles(part('styles'));
	const date1904 = elements(xml, 'workbookPr').some((a) => /^(1|true)$/.test(attr(a, 'date1904') ?? ''));
	const cells = /<(?:\w+:)?c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)|<\/(?:\w+:)?row>/g;

	const cellText = (attrs: string, body: string): string => {
		const type = attr(attrs, 't');
		if (type === 'inlineStr') return richText(body);
		const value = /<(?:\w+:)?v(?:\s[^>]*)?>([^<]*)<\//.exec(body)?.[1];
		if (value === undefined) return '';
		if (type === 's') return strings[Number(value)] ?? '';
		if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
		const number = Number(value);
		const dated = (!type || type === 'n') && isDate[Number(attr(attrs, 's') ?? 0)];
		return dated && value && Number.isFinite(number) ? serialDate(number, date1904) : decodeXml(value);
	};

	return elements(xml, 'sheet')
		.map((attrs) => {
			const sheet = rels.find((r) => r.id === attr(attrs, '\\w+:id'));
			const rows: string[] = [];
			let row: string[] = [];
			for (const [token, cellAttrs = '', body = ''] of (read(sheet?.target ?? '') ?? '').matchAll(cells)) {
				if (token.startsWith('</')) {
					if (row.length > 0) rows.push(row.join('\t'));
					row = [];
					continue;
				}
				// Cell references keep columns unambiguous when cells are missing.
				const text = cellText(cellAttrs, body).replace(/\s*[\r\n]+\s*/g, ' ');
				if (text) row.push(`${attr(cellAttrs, 'r') ?? ''}: ${text}`);
			}
			return `# Sheet: ${attr(attrs, 'name') ?? ''}\n${rows.join('\n')}`;
		})
		.join('\n\n');
}

export function isOfficeMime(mimeType: string): boolean {
	return mimeType.startsWith(OFFICE_MIME_PREFIX);
}

/** Plain text of a .docx, .xlsx, or .pptx file. Throws when it cannot be read. */
export function extractOfficeText(bytes: Buffer, mimeType: string): string {
	const read = openZip(bytes);
	const main = relationships(read, '').find((r) => r.type.endsWith('/officeDocument'))?.target;
	const xml = main ? read(main) : undefined;
	if (!main || xml === undefined) throw new Error('not an Office document');
	switch (mimeType.slice(OFFICE_MIME_PREFIX.length).split('.')[0]) {
		case 'spreadsheetml':
			return sheetsText(read, main, xml);
		case 'presentationml':
			return slidesText(read, main, xml);
		default:
			return paragraphs(xml, 'w');
	}
}
