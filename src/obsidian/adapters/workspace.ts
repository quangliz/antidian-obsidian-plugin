import { App, MarkdownView } from 'obsidian';
import { ActiveContext, ContextService } from '../../core/types/context';
import { ObsidianEditorAdapter } from './editor';

export class ObsidianWorkspaceAdapter implements ContextService {
	private app: App;
	private listeners: Set<(context: ActiveContext) => void> = new Set();
	private cleanups: (() => void)[] = [];

	constructor(app: App) {
		this.app = app;
		this.initListeners();
	}

	getActiveContext(): ActiveContext {
		const activeFile = this.app.workspace.getActiveFile();
		const markdownView =
			this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = markdownView?.editor;

		return {
			activeFile: activeFile ? activeFile.path : undefined,
			selection: ObsidianEditorAdapter.getSelection(editor),
			cursor: ObsidianEditorAdapter.getCursor(editor),
		};
	}

	onContextChange(callback: (context: ActiveContext) => void): () => void {
		this.listeners.add(callback);
		callback(this.getActiveContext());
		return () => {
			this.listeners.delete(callback);
		};
	}

	private notify(): void {
		const context = this.getActiveContext();
		for (const listener of this.listeners) {
			listener(context);
		}
	}

	private initListeners(): void {
		const update = () => this.notify();

		const leafRef = this.app.workspace.on('active-leaf-change', update);
		const fileRef = this.app.workspace.on('file-open', update);
		const editorRef = this.app.workspace.on('editor-change', update);

		const onSelectionChange = () => {
			update();
		};

		activeDocument.addEventListener('selectionchange', onSelectionChange);

		this.cleanups.push(
			() => this.app.workspace.offref(leafRef),
			() => this.app.workspace.offref(fileRef),
			() => this.app.workspace.offref(editorRef),
			() =>
				activeDocument.removeEventListener(
					'selectionchange',
					onSelectionChange,
				),
		);
	}

	destroy(): void {
		for (const cleanup of this.cleanups) {
			cleanup();
		}
		this.cleanups = [];
		this.listeners.clear();
	}
}
