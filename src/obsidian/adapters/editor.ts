import { Editor } from 'obsidian';

export class ObsidianEditorAdapter {
	static getSelection(editor?: Editor): string | undefined {
		if (!editor) return undefined;
		const sel = editor.getSelection();
		return sel && sel.length > 0 ? sel : undefined;
	}

	static getCursor(
		editor?: Editor,
	): { line: number; ch: number } | undefined {
		if (!editor) return undefined;
		const cur = editor.getCursor();
		return cur ? { line: cur.line, ch: cur.ch } : undefined;
	}
}
