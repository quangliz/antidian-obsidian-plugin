import './ts-resolve.mjs';
import http from 'node:http';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { binaryMimeForPath } from '../src/core/files.ts';
import { extractOfficeText } from '../src/core/office.ts';
import { McpToolServer } from '../src/core/models/mcp-tool-server.ts';
import { parseAgyTranscriptJsonl } from '../src/core/sessions/transcript.ts';
import { ToolRegistry, createReadNoteTool } from '../src/core/tools/index.ts';
import { ChangeSetValidator } from '../src/core/transactions/validator.ts';

const binaries = {
	'a b.png': { mimeType: 'image/png', data: 'aW1n' },
	'doc.pdf': { mimeType: 'application/pdf', data: 'cGRm' },
};
const vault = {
	async readBinary(path) {
		if (path === 'big.mp4') throw new Error('"big.mp4" is too large to read (limit 100 MB).');
		return binaries[path] ? { path, size: 3, mtime: 5, ...binaries[path] } : null;
	},
	async readNote({ path }) {
		if (path === 'x.zip') return { path, content: 'PK\0\0' };
		return { path, content: 'text', mtime: 1 };
	},
};

test('binaryMimeForPath covers media and documents, and treats SVG and unknown types as text', () => {
	assert.equal(binaryMimeForPath('Assets/Shot.PNG'), 'image/png');
	assert.equal(binaryMimeForPath('a.pdf'), 'application/pdf');
	assert.equal(binaryMimeForPath('a.mov'), 'video/mp4');
	assert.equal(binaryMimeForPath('a.tiff'), 'image/tiff');
	for (const path of ['a.svg', 'a.md', 'a.canvas', 'a.base', 'noext']) {
		assert.equal(binaryMimeForPath(path), undefined);
	}
});

test('read_note returns non-text files as MCP content and keeps bytes out of UI events', async () => {
	const registry = new ToolRegistry();
	registry.register(createReadNoteTool(vault));
	const server = new McpToolServer(registry);
	const info = await server.start();
	try {
		const ended = [];
		const contextRefs = [];
		server.setTurnContext(
			{ permissionMode: 'ask', recordContext: (ref) => contextRefs.push(ref.path) },
			{ onToolEnd: (e) => ended.push(e.toolOutput) },
		);
		const read = (path) =>
			new Promise((resolve, reject) => {
				const req = http.request(
					info.url,
					{ method: 'POST', headers: { Authorization: `Bearer ${info.token}` } },
					(res) => {
						let data = '';
						res.on('data', (chunk) => (data += chunk));
						res.on('end', () => resolve(JSON.parse(data).result));
					},
				);
				req.on('error', reject);
				req.end(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						method: 'tools/call',
						params: { name: 'read_note', arguments: { path } },
					}),
				);
			});

		const png = await read('a b.png');
		assert.deepEqual(png.content[1], { type: 'image', mimeType: 'image/png', data: 'aW1n' });
		const meta = JSON.parse(png.content[0].text);
		assert.equal(meta.path, 'a b.png');
		assert.equal(meta.size, 3);
		assert.equal('data' in meta, false);
		assert.equal(JSON.stringify(ended[0]).includes('aW1n'), false);
		assert.deepEqual(contextRefs, ['a b.png']);

		const pdf = await read('doc.pdf');
		assert.deepEqual(pdf.content[1], {
			type: 'resource',
			resource: { uri: 'vault:///doc.pdf', mimeType: 'application/pdf', blob: 'cGRm' },
		});

		const note = await read('n.md');
		assert.equal(note.content.length, 1);
		assert.equal(JSON.parse(note.content[0].text).content, 'text');

		for (const [path, message] of [['big.mp4', /too large/], ['x.zip', /unsupported type/]]) {
			const failed = await read(path);
			assert.equal(failed.isError, true);
			assert.match(failed.content[0].text, message);
		}
	} finally {
		await server.stop();
	}
});

const OFFICE = 'application/vnd.openxmlformats-officedocument.';

/** Minimal ZIP: one deflated entry per part. */
function zip(parts) {
	const local = [];
	const central = [];
	let offset = 0;
	for (const [name, xml] of Object.entries(parts)) {
		const data = deflateRawSync(xml);
		const head = Buffer.alloc(30);
		head.writeUInt32LE(0x04034b50, 0);
		head.writeUInt16LE(name.length, 26);
		const dir = Buffer.alloc(46);
		dir.writeUInt32LE(0x02014b50, 0);
		dir.writeUInt16LE(8, 10);
		dir.writeUInt32LE(data.length, 20);
		dir.writeUInt16LE(name.length, 28);
		dir.writeUInt32LE(offset, 42);
		local.push(head, Buffer.from(name), data);
		central.push(dir, Buffer.from(name));
		offset += 30 + name.length + data.length;
	}
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(parts).length, 10);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, ...central, end]);
}
const rels = (...items) =>
	items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://x/${type}" Target="${target}"/>`).join('');

test('extractOfficeText reads Word paragraphs, tables, and breaks', () => {
	const docx = zip({
		'_rels/.rels': rels(['r1', 'officeDocument', '/word/document2.xml']),
		'word/document2.xml':
			'<w:p><w:pPr><w:tabs><w:tab w:val="left"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">Tom &amp; </w:t></w:r><w:r><w:t>J&#233;r&#xF4;me</w:t><w:tab/><w:t>x</w:t><w:br/><w:t>y</w:t><w:delText>gone</w:delText></w:r></w:p>' +
			'<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl><mc:Fallback><w:t>dup</w:t></mc:Fallback>',
	});
	assert.equal(extractOfficeText(docx, `${OFFICE}wordprocessingml.document`), 'Tom & Jérôme\tx\ny\na\tb');
});

test('extractOfficeText reads Excel strings, dates, and gaps per sheet', () => {
	const xlsx = zip({
		'_rels/.rels': rels(['r1', 'officeDocument', 'xl/workbook.xml']),
		'xl/workbook.xml': '<workbook><workbookPr/><sheets><sheet name="Q&amp;A" sheetId="1" r:id="rId2"/></sheets></workbook>',
		'xl/_rels/workbook.xml.rels': rels(
			['rId2', 'worksheet', 'worksheets/sheet7.xml'],
			['rId3', 'sharedStrings', 'sharedStrings.xml'],
			['rId4', 'styles', 'styles.xml'],
		),
		'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><r><t>Ri</t></r><r><t>ch</t></r><rPh><t>no</t></rPh></si></sst>',
		'xl/styles.xml':
			'<numFmts><numFmt numFmtId="170" formatCode="dd/mm/yyyy hh:mm"/><numFmt numFmtId="171" formatCode="[Red]0&quot; days&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="170"/><xf numFmtId="171"/></cellXfs>',
		'xl/worksheets/sheet7.xml':
			'<cols><col min="1"/></cols><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"/><c r="C1" t="s"><v>1</v></c></row><row r="2"/>' +
			'<row r="3"><c r="A3" s="1"><v>45992</v></c><c r="B3" s="2"><v>45992.5</v></c><c r="C3" s="3"><v>5</v></c><c r="D3" t="b"><v>1</v></c><c r="E3" t="inlineStr"><is><t>in</t></is></c><c r="F3"><f>1+1</f><v>2</v></c></row>',
	});
	assert.equal(
		extractOfficeText(xlsx, `${OFFICE}spreadsheetml.sheet`),
		'# Sheet: Q&A\nA1: Name\tC1: Rich\nA3: 2025-12-01\tB3: 2025-12-01 12:00:00\tC3: 5\tD3: TRUE\tE3: in\tF3: 2',
	);
});

test('extractOfficeText reads PowerPoint slides in presentation order', () => {
	const pptx = zip({
		'_rels/.rels': rels(['r1', 'officeDocument', 'ppt/presentation.xml']),
		'ppt/presentation.xml':
			'<p:sldIdLst><p:sldId id="257" r:id="rId9"/><p:sldId id="256" r:id="rId8"/></p:sldIdLst><p14:sldIdLst><p14:sldId id="256"/></p14:sldIdLst>',
		'ppt/_rels/presentation.xml.rels': rels(['rId8', 'slide', 'slides/slide1.xml'], ['rId9', 'slide', '../ppt/slides/slide2.xml']),
		'ppt/slides/slide1.xml': '<a:p><a:r><a:t>Last</a:t></a:r></a:p>',
		'ppt/slides/slide2.xml': '<a:p><a:r><a:t>First</a:t></a:r><a:br><a:rPr/></a:br><a:r><a:t>line</a:t></a:r></a:p>',
	});
	assert.equal(extractOfficeText(pptx, `${OFFICE}presentationml.presentation`), '# Slide 1\nFirst\nline\n\n# Slide 2\nLast');
});

test('extractOfficeText rejects files that are not readable packages', () => {
	assert.throws(() => extractOfficeText(Buffer.from('\xd0\xcf'), `${OFFICE}wordprocessingml.document`), /password-protected/);
	assert.throws(() => extractOfficeText(zip({ 'a.txt': 'x' }), `${OFFICE}wordprocessingml.document`), /not an Office document/);
	const bomb = zip({ '_rels/.rels': Buffer.alloc(101 * 1024 * 1024) });
	assert.throws(() => extractOfficeText(bomb, `${OFFICE}wordprocessingml.document`));
});

test('read_note returns Office documents as text', async () => {
	const mimeType = `${OFFICE}wordprocessingml.document`;
	const data = zip({
		'_rels/.rels': rels(['r1', 'officeDocument', 'word/document.xml']),
		'word/document.xml': '<w:p><w:r><w:t>Hello</w:t></w:r></w:p>',
	}).toString('base64');
	const tool = createReadNoteTool({ ...vault, readBinary: async (path) => ({ path, mimeType, data, size: 1, mtime: 5 }) });
	assert.deepEqual(await tool.execute({ path: 'a.docx' }), { path: 'a.docx', content: 'Hello', mtime: 5 });
	const broken = createReadNoteTool({ ...vault, readBinary: async (path) => ({ path, mimeType, data: 'AAAA', size: 1, mtime: 5 }) });
	await assert.rejects(broken.execute({ path: 'b.docx' }), /Could not read "b.docx"/);
});

test('ChangeSetValidator rejects text edits to non-text files', async () => {
	const validator = new ChangeSetValidator({
		normalizePath: (p) => p,
		isPathWithinVault: () => true,
		fileExists: async () => true,
		getFileMtime: async () => null,
		headingExists: async () => true,
		readNote: async ({ path }) => ({ path, content: path === 'a.docx' ? 'PK\0' : 'x' }),
	});
	const result = await validator.validate({
		id: 'c',
		status: 'staged',
		operations: [
			{ id: '1', type: 'append', path: 'a.png', content: 'y' },
			{ id: '2', type: 'append', path: 'a.svg', content: 'y' },
			{ id: '3', type: 'append', path: 'a.docx', content: 'y' },
		],
	});
	assert.deepEqual(result.errors.map((e) => [e.path, e.code]), [['a.png', 'binary_file'], ['a.docx', 'binary_file']]);
});

test('replayed file reads keep their structured result', () => {
	const [turn] = parseAgyTranscriptJsonl(
		[
			{ type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' },
			{ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'mcp_anti-dian-vault_read_note', args: { path: 'a.png' } }] },
			{
				type: 'GENERIC',
				content:
					'Created At: 2026-11-25T12:37:40+07:00\nCompleted At: 2026-11-25T12:37:41+07:00\n{"path":"a.png","mimeType":"image/png"}\n[Resource offloaded to file:///h/.system_generated/steps/2/media_0.png]',
			},
		]
			.map((s) => JSON.stringify(s))
			.join('\n'),
	);
	assert.deepEqual(turn.events[0].output, { path: 'a.png', mimeType: 'image/png' });
});
