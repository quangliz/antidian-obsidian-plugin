import {
	RangeSetBuilder,
	StateEffect,
	StateField,
	type Extension,
} from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	EditorView,
	WidgetType,
} from '@codemirror/view';
import { App, MarkdownView, editorInfoField } from 'obsidian';
import type { ApprovalDecision, ApprovalRequest } from '../../core/transactions';
import type { DiffHunk, FileDiff } from '../../core/types/changes';

const refreshInlineDiffEffect = StateEffect.define<null>();

export interface PendingInlineReview {
	callId: string;
	diff: FileDiff;
	onDecision: (decision: ApprovalDecision) => void;
}

export interface InlineDiffBlock {
	/** 1-based line number in the current document where removed lines start/end. */
	removedLines: number[];
	/** 1-based line number after which added lines are rendered (0 = top of doc). */
	anchorLine: number;
	addedLines: string[];
	showActions: boolean;
}

/**
 * Maps a `FileDiff` onto 1-based line numbers in the currently open document.
 */
export function computeInlineDiffBlocks(
	diff: FileDiff,
	docLineCount: number,
): InlineDiffBlock[] {
	const clamp = (line: number): number =>
		Math.max(1, Math.min(Math.max(1, docLineCount), line));
	const blocks: InlineDiffBlock[] = [];

	const processHunk = (hunk: DiffHunk, isFirstHunk: boolean): void => {
		const removed: number[] = [];
		let currentAdded: string[] = [];
		let lastOldLine = 0;
		let emittedActionBar = false;

		const flushAdded = () => {
			if (currentAdded.length === 0 && removed.length === 0) return;
			const anchor =
				lastOldLine > 0
					? clamp(lastOldLine)
					: removed.length > 0
						? clamp(removed[removed.length - 1] ?? 1)
						: 0;
			blocks.push({
				removedLines: [...removed],
				anchorLine: anchor,
				addedLines: [...currentAdded],
				showActions: isFirstHunk && !emittedActionBar,
			});
			emittedActionBar = true;
			removed.length = 0;
			currentAdded = [];
		};

		for (const line of hunk.lines) {
			if (line.type === 'context') {
				if (currentAdded.length > 0 || removed.length > 0) {
					flushAdded();
				}
				if (line.oldLineNumber !== undefined) {
					lastOldLine = line.oldLineNumber;
				}
			} else if (line.type === 'removed') {
				if (currentAdded.length > 0) {
					flushAdded();
				}
				if (line.oldLineNumber !== undefined) {
					removed.push(clamp(line.oldLineNumber));
					lastOldLine = line.oldLineNumber;
				}
			} else if (line.type === 'added') {
				currentAdded.push(line.content);
			}
		}

		flushAdded();
	};

	diff.hunks.forEach((hunk, idx) => processHunk(hunk, idx === 0));

	if (blocks.length > 0 && !blocks.some((b) => b.showActions)) {
		const first = blocks[0];
		if (first) first.showActions = true;
	}
	return blocks;
}

class InlineDiffAddedWidget extends WidgetType {
	constructor(
		private readonly addedLines: string[],
		private readonly additions: number,
		private readonly deletions: number,
		private readonly showActions: boolean,
		private readonly onDecision: (decision: ApprovalDecision) => void,
	) {
		super();
	}

	override eq(other: InlineDiffAddedWidget): boolean {
		return (
			this.showActions === other.showActions &&
			this.additions === other.additions &&
			this.deletions === other.deletions &&
			this.addedLines.length === other.addedLines.length &&
			this.addedLines.every((l, i) => l === other.addedLines[i])
		);
	}

	override toDOM(): HTMLElement {
		const container = createDiv({ cls: 'antidian-cm-diff-widget' });

		if (this.showActions) {
			const bar = container.createDiv({ cls: 'antidian-cm-diff-bar' });
			bar.createSpan({
				cls: 'antidian-cm-diff-badge',
				text: `Antidian proposed edit (+${this.additions} / -${this.deletions})`,
			});
			const actions = bar.createDiv({ cls: 'antidian-cm-diff-actions' });

			const acceptBtn = actions.createEl('button', {
				cls: 'antidian-cm-diff-btn is-accept',
				text: 'Accept',
				attr: { type: 'button' },
			});
			acceptBtn.addEventListener('mousedown', (e) => {
				e.preventDefault();
				e.stopPropagation();
			});
			acceptBtn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.onDecision('approve');
			});

			const rejectBtn = actions.createEl('button', {
				cls: 'antidian-cm-diff-btn is-reject',
				text: 'Reject',
				attr: { type: 'button' },
			});
			rejectBtn.addEventListener('mousedown', (e) => {
				e.preventDefault();
				e.stopPropagation();
			});
			rejectBtn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.onDecision('reject');
			});
		}

		if (this.addedLines.length > 0) {
			const linesEl = container.createDiv({ cls: 'antidian-cm-diff-added' });
			for (const line of this.addedLines) {
				const row = linesEl.createDiv({ cls: 'antidian-cm-diff-added-line' });
				row.createSpan({ cls: 'antidian-cm-diff-gutter', text: '+' });
				row.createSpan({
					cls: 'antidian-cm-diff-text',
					text: line.length > 0 ? line : ' ',
				});
			}
		}

		return container;
	}

	override ignoreEvent(): boolean {
		return true;
	}
}

/**
 * Manages live inline diff decorations in open Obsidian Markdown editors for
 * pending `ask`-mode write approvals.
 */
export class InlineDiffController {
	private app: App;
	private pendingByPath = new Map<string, PendingInlineReview>();
	private pathByCallId = new Map<string, string>();
	private extension: Extension;

	constructor(app: App) {
		this.app = app;

		const field = StateField.define<DecorationSet>({
			create: (state) => this.buildDecorations(state),
			update: (decorations, tr) => {
				const refreshed = tr.effects.some((e) =>
					e.is(refreshInlineDiffEffect),
				);
				if (refreshed || tr.docChanged) {
					return this.buildDecorations(tr.state);
				}
				return decorations;
			},
			provide: (f) => EditorView.decorations.from(f),
		});

		this.extension = field;
	}

	getEditorExtension(): Extension {
		return this.extension;
	}

	showPendingReview(
		request: ApprovalRequest,
		onDecision: (decision: ApprovalDecision) => void,
	): void {
		const notePath = request.diff.path;
		this.pendingByPath.set(notePath, {
			callId: request.callId,
			diff: request.diff,
			onDecision,
		});
		this.pathByCallId.set(request.callId, notePath);
		this.refreshOpenEditors();
	}

	clearPendingReview(callId: string): void {
		const notePath = this.pathByCallId.get(callId);
		if (!notePath) return;
		this.pathByCallId.delete(callId);
		const current = this.pendingByPath.get(notePath);
		if (current?.callId === callId) {
			this.pendingByPath.delete(notePath);
		}
		this.refreshOpenEditors();
	}

	clearAll(): void {
		this.pendingByPath.clear();
		this.pathByCallId.clear();
		this.refreshOpenEditors();
	}

	hasPendingReviewForActiveFile(): boolean {
		return this.getActivePendingReview() !== null;
	}

	resolveActiveReview(decision: ApprovalDecision): boolean {
		const active = this.getActivePendingReview();
		if (!active) return false;
		active.onDecision(decision);
		return true;
	}

	private getActivePendingReview(): PendingInlineReview | null {
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile) {
			const match = this.pendingByPath.get(activeFile.path);
			if (match) return match;
		}
		// Fallback: if only one review is pending anywhere, allow resolving it
		if (this.pendingByPath.size === 1) {
			return this.pendingByPath.values().next().value ?? null;
		}
		return null;
	}

	private buildDecorations(state: EditorView['state']): DecorationSet {
		let filePath: string | undefined;
		try {
			filePath = state.field(editorInfoField, false)?.file?.path;
		} catch {
			return Decoration.none;
		}
		if (!filePath) return Decoration.none;

		const review = this.pendingByPath.get(filePath);
		if (!review) return Decoration.none;

		const blocks = computeInlineDiffBlocks(review.diff, state.doc.lines);
		if (blocks.length === 0) return Decoration.none;

		type DecoEntry = { from: number; deco: Decoration };
		const entries: DecoEntry[] = [];

		for (const block of blocks) {
			for (const lineNum of block.removedLines) {
				if (lineNum >= 1 && lineNum <= state.doc.lines) {
					const line = state.doc.line(lineNum);
					entries.push({
						from: line.from,
						deco: Decoration.line({ class: 'antidian-cm-diff-removed' }),
					});
				}
			}

			if (block.addedLines.length > 0 || block.showActions) {
				const pos =
					block.anchorLine >= 1 && block.anchorLine <= state.doc.lines
						? state.doc.line(block.anchorLine).to
						: 0;
				entries.push({
					from: pos,
					deco: Decoration.widget({
						widget: new InlineDiffAddedWidget(
							block.addedLines,
							review.diff.additions,
							review.diff.deletions,
							block.showActions,
							review.onDecision,
						),
						side: 1,
						block: true,
					}),
				});
			}
		}

		entries.sort((a, b) => a.from - b.from);
		const builder = new RangeSetBuilder<Decoration>();
		for (const entry of entries) {
			builder.add(entry.from, entry.from, entry.deco);
		}
		return builder.finish();
	}

	private refreshOpenEditors(): void {
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		for (const leaf of leaves) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			if (cm) {
				cm.dispatch({ effects: refreshInlineDiffEffect.of(null) });
			}
		}
	}
}
