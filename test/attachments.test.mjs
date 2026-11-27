import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	isAttachableMime,
	mediaKind,
	mediaMimeForName,
	parseClipboardFilePaths,
	parseFileUriList,
	parseGnomeCopiedFiles,
} from '../src/obsidian/views/attachments.ts';

test('mediaMimeForName maps media extensions and ignores others', () => {
	assert.equal(mediaMimeForName('/home/u/Shot.PNG'), 'image/png');
	assert.equal(mediaMimeForName('clip.mkv'), 'video/x-matroska');
	assert.equal(mediaMimeForName('song.flac'), 'audio/flac');
	assert.equal(mediaMimeForName('notes.md'), undefined);
	assert.equal(mediaMimeForName('noext'), undefined);
	assert.equal(mediaKind('video/mp4'), 'video');
	assert.equal(mediaKind('audio/wav'), 'audio');
	assert.equal(mediaKind('image/gif'), 'image');
	assert.equal(isAttachableMime('application/pdf'), false);
});

test('parseFileUriList only accepts clipboard text made of file:// URIs', () => {
	assert.deepEqual(
		parseFileUriList('file:///home/u/My%20Pics/a.png\r\nfile:///home/u/b.mp4\n'),
		['/home/u/My Pics/a.png', '/home/u/b.mp4'],
	);
	assert.deepEqual(parseFileUriList('# comment\nfile:///C:/x/y.jpg'), ['C:/x/y.jpg']);
	// Ordinary text, or a URI mixed with text, pastes as text.
	assert.deepEqual(parseFileUriList('hello'), []);
	assert.deepEqual(parseFileUriList('see file:///a.png'), []);
	assert.deepEqual(parseFileUriList('file:///a.png\nhttps://x.y'), []);
	assert.deepEqual(parseFileUriList(''), []);
});

test('parseClipboardFilePaths accepts plain absolute media paths (Nautilus text/plain)', () => {
	assert.deepEqual(
		parseClipboardFilePaths('/home/u/Pictures/Screenshots/Screenshot 2026-11-24 21-42-26.png'),
		['/home/u/Pictures/Screenshots/Screenshot 2026-11-24 21-42-26.png'],
	);
	assert.deepEqual(parseClipboardFilePaths('/a/b.png\n/c/d.mp4'), ['/a/b.png', '/c/d.mp4']);
	assert.deepEqual(parseClipboardFilePaths('C:\\Users\\me\\shot.jpg'), ['C:\\Users\\me\\shot.jpg']);
	assert.deepEqual(parseClipboardFilePaths('file:///x/y.png'), ['/x/y.png']);
	// Non-media paths, relative paths and prose stay text.
	assert.deepEqual(parseClipboardFilePaths('/etc/hosts'), []);
	assert.deepEqual(parseClipboardFilePaths('images/a.png'), []);
	assert.deepEqual(parseClipboardFilePaths('look at /a/b.png'), []);
	assert.deepEqual(parseClipboardFilePaths('/a/b.png\nnotes'), []);
});

test('parseGnomeCopiedFiles reads Nautilus copy/cut payloads', () => {
	assert.deepEqual(
		parseGnomeCopiedFiles('copy\nfile:///home/u/Pictures/Screenshots/Screenshot%202026-11-24%2021-42-26.png'),
		['/home/u/Pictures/Screenshots/Screenshot 2026-11-24 21-42-26.png'],
	);
	assert.deepEqual(parseGnomeCopiedFiles('cut\nfile:///a.png\nfile:///b.jpg'), ['/a.png', '/b.jpg']);
	assert.deepEqual(parseGnomeCopiedFiles('hello'), []);
});
