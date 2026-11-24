import {
	App,
	Component,
	HoverParent,
	MarkdownRenderer,
	Notice,
	TFile,
	setIcon,
	setTooltip,
} from 'obsidian';
import type { ContextReference } from '../../core/types/context';
import type { ChangeSetDiff, FileDiff } from '../../core/types/changes';
import { bindNoteLink, linkifyCodeWikilinks } from './note-link';
import { buildToolDetail, isStagedMutation } from './tool-detail';
import { AgentStepEvent } from '../../core/agent';

export interface SourceItem {
	title: string;
	subtitle?: string;
	href?: string;
	path?: string;
}

export interface ThinkingStep {
	id: string;
	/** Diff of the change this call staged (mutating tools only). */
	fileDiff?: FileDiff;
	callId?: string;
	toolName: string;
	kind: 'search' | 'code' | 'step';
	query?: string;
	primary: string;
	secondary?: string;
	mono?: boolean;
	add?: number;
	del?: number;
	status: 'running' | 'done' | 'error';
	sources?: SourceItem[];
	args?: Record<string, unknown>;
	output?: unknown;
	error?: string;
}

/** One contiguous run of model reasoning, shown between tool rows. */
interface ThoughtPhase {
	receivedText: string;
	displayedText: string;
	/** Index of the tool step this phase is rendered before (steps.length = after all). */
	afterStep: number;
	/** No more text will arrive (a tool started, a new phase began, or the turn ended). */
	closed: boolean;
	/** Live element; reused across re-renders so streaming only touches its text. */
	el?: HTMLElement;
	/** Set once the finished phase has been rendered as Markdown. */
	renderedMarkdown?: boolean;
	userExpanded?: boolean;
}

/** Typewriter catches up with the received text within roughly this many frames. */
const THOUGHT_CATCHUP_FRAMES = 20;
const THOUGHT_MIN_CHARS_PER_FRAME = 3;

const basename = (path: unknown): string | undefined =>
	typeof path === 'string'
		? path.replace(/\.md$/, '').split('/').pop() || path
		: undefined;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const quoted = (value: unknown): string | undefined =>
	typeof value === 'string' && value ? `"${value}"` : undefined;

export class ThinkingStateView {
	private app: App;
	private component: Component;
	private hoverParent?: HoverParent;
	private containerEl: HTMLElement;
	private headerBtnEl!: HTMLButtonElement;
	private sparkleIconEl!: HTMLElement;
	private statusTextEl!: HTMLElement;
	private chevronIconEl!: HTMLElement;
	private traceWrapperEl!: HTMLElement;
	private traceContentEl!: HTMLElement;
	private guideLineEl!: HTMLElement;
	private rowsContainerEl!: HTMLElement;

	private steps: ThinkingStep[] = [];
	private isExpanded = false;
	private isSettled = false;
	private startTime = 0;
	private endTime = 0;
	private activeStatus = 'Thinking';
	private thoughtPhases: ThoughtPhase[] = [];
	private thoughtAnimationFrame: number | null = null;
	private thoughtWaiters: (() => void)[] = [];
	/** Context the turn used without a tool call (active note, selection). */
	private ambient: { path: string; selection?: string } | null = null;
	/** Settled header summary; file names are rendered as emphasized spans. */
	private summaryParts: { text: string; file?: boolean }[] | null = null;
	/** Steps whose detail panel is open (errors open automatically). */
	private openStepIds = new Set<string>();
	private getShowRawToolData: () => boolean;

	constructor(
		containerEl: HTMLElement,
		app: App,
		component: Component,
		hoverParent?: HoverParent,
		getShowRawToolData: () => boolean = () => false,
	) {
		this.hoverParent = hoverParent;
		this.getShowRawToolData = getShowRawToolData;
		this.app = app;
		this.component = component;
		this.containerEl = containerEl.createDiv({
			cls: 'anti-dian-thinking-state',
		});
		this.startTime = performance.now();
		this.render();
	}

	public handleStep(step: AgentStepEvent): void {
		if (step.type === 'thinking') {
			this.activeStatus = 'Thinking';
			this.isExpanded = true;
			this.updateHeader();
		} else if (step.type === 'thought_delta') {
			const isNewPhase = this.ensureOpenPhase();
			const phase = this.thoughtPhases[this.thoughtPhases.length - 1];
			if (phase) phase.receivedText += step.text;
			if (!this.isExpanded || isNewPhase) {
				this.isExpanded = true;
				this.updateHeader();
				this.renderSteps();
			}
			this.startThoughtStream();
		} else if (step.type === 'tool_start') {
			// Reasoning that arrives after this tool belongs below it.
			this.closeOpenPhase();
			const isSearch = step.toolName === 'search_notes' || step.toolName === 'web_search';
			const formatted = this.formatToolStep(step.toolName, step.toolArgs);
			const newStep: ThinkingStep = {
				id: `step_${this.steps.length + 1}`,
				callId: step.callId,
				toolName: step.toolName,
				kind: isSearch ? 'search' : 'code',
				query: typeof step.toolArgs.query === 'string' ? step.toolArgs.query : undefined,
				primary: formatted.primary,
				secondary: formatted.secondary,
				mono: formatted.mono,
				status: 'running',
				args: step.toolArgs,
				sources: [],
			};
			this.steps.push(newStep);
			this.activeStatus = isSearch
				? step.toolName === 'web_search'
					? 'Searching the web'
					: 'Searching notes'
				: `Running ${formatted.primary.toLowerCase()}`;

			this.isExpanded = true;
			this.updateHeader();
			this.renderSteps();
		} else if (step.type === 'tool_end') {
			// Pair by call id when available; otherwise the oldest running call
			// of the same tool (calls of one tool finish roughly in order).
			const current =
				(step.callId
					? this.steps.find((s) => s.callId === step.callId)
					: undefined) ??
				this.steps.find(
					(s) => s.toolName === step.toolName && s.status === 'running',
				);

			if (current) {
				const isError =
					step.toolOutput &&
					typeof step.toolOutput === 'object' &&
					'error' in step.toolOutput;
				current.status = isError ? 'error' : 'done';
				current.output = step.toolOutput;
				if (isError) {
					current.error = String((step.toolOutput as { error: unknown }).error);
					this.openStepIds.add(current.id);
				}

				// Extract search result sources
				if (current.toolName === 'search_notes' && Array.isArray(step.toolOutput)) {
					const items = (step.toolOutput as unknown[]).filter(
						(item): item is { path?: string; heading?: string } =>
							typeof item === 'object' && item !== null,
					);
					current.sources = items.map((item) => {
						const path = typeof item.path === 'string' ? item.path : 'Untitled';
						const noteName = path.replace(/\.md$/, '').split('/').pop() || path;
						const folder = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
						return {
							title: item.heading ? `${noteName} > #${item.heading}` : noteName,
							subtitle: folder || undefined,
							path,
						};
					});
				} else if (current.toolName === 'web_search') {
					let sourceList: Array<{ title?: string; url?: string }> = [];
					if (Array.isArray(step.toolOutput)) {
						sourceList = (step.toolOutput as unknown[]).filter(
							(item): item is { title?: string; url?: string } =>
								typeof item === 'object' && item !== null,
						);
					} else if (step.toolOutput && typeof step.toolOutput === 'object') {
						const out = step.toolOutput as {
							sources?: unknown[];
							results?: unknown[];
						};
						if (Array.isArray(out.sources)) {
							sourceList = out.sources.filter(
								(item): item is { title?: string; url?: string } =>
									typeof item === 'object' && item !== null,
							);
						} else if (Array.isArray(out.results)) {
							sourceList = out.results.filter(
								(item): item is { title?: string; url?: string } =>
									typeof item === 'object' && item !== null,
							);
						}
					}

					current.sources = sourceList.map((item) => {
						let domain = '';
						if (item.url) {
							try {
								domain = new URL(item.url).hostname.replace(/^www\./, '');
							} catch {
								domain = item.url;
							}
						}
						return {
							title: item.title || domain || 'Web source',
							subtitle: domain || undefined,
							href: item.url,
						};
					});
				}

				// Extract diff stats for patch/create
				if (
					step.toolOutput &&
					typeof step.toolOutput === 'object' &&
					'diff' in step.toolOutput
				) {
					const diff = (step.toolOutput as { diff?: { added?: number; deleted?: number } }).diff;
					if (diff) {
						current.add = diff.added;
						current.del = diff.deleted;
					}
				}
			}
			this.activeStatus = 'Thinking';
			this.updateHeader();
			this.renderSteps();
		} else if (step.type === 'error') {
			this.activeStatus = `Error: ${step.message}`;
			this.updateHeader();
		}
	}

	public isThoughtStreaming(): boolean {
		return this.thoughtPhases.some(
			(phase) => phase.displayedText.length < phase.receivedText.length,
		);
	}

	public waitForThoughtStream(): Promise<void> {
		if (!this.isThoughtStreaming()) return Promise.resolve();
		return new Promise((resolve) => this.thoughtWaiters.push(resolve));
	}

	/** Start a new phase if there is none open, or tools ran since it began. */
	private ensureOpenPhase(): boolean {
		const last = this.thoughtPhases[this.thoughtPhases.length - 1];
		if (last && !last.closed && last.afterStep === this.steps.length) return false;
		if (last) last.closed = true;
		this.thoughtPhases.push({
			receivedText: '',
			displayedText: '',
			afterStep: this.steps.length,
			closed: false,
		});
		return true;
	}

	private closeOpenPhase(): void {
		const last = this.thoughtPhases[this.thoughtPhases.length - 1];
		if (last && !last.closed) {
			last.closed = true;
			this.finalizePhaseIfDone(last);
		}
	}

	private startThoughtStream(): void {
		if (this.thoughtAnimationFrame !== null) return;
		const advance = () => {
			const phase = this.thoughtPhases.find(
				(item) => item.displayedText.length < item.receivedText.length,
			);
			if (phase) {
				// Speed scales with the backlog so long reasoning never lags far
				// behind (tool calls wait for the typewriter to catch up).
				const backlog = phase.receivedText.length - phase.displayedText.length;
				const step = Math.max(
					THOUGHT_MIN_CHARS_PER_FRAME,
					Math.ceil(backlog / THOUGHT_CATCHUP_FRAMES),
				);
				phase.displayedText = phase.receivedText.slice(
					0,
					phase.displayedText.length + step,
				);
				this.updatePhaseText(phase);
				this.finalizePhaseIfDone(phase);
			}

			if (this.isThoughtStreaming()) {
				this.thoughtAnimationFrame = window.requestAnimationFrame(advance);
			} else {
				this.thoughtAnimationFrame = null;
				for (const resolve of this.thoughtWaiters.splice(0)) resolve();
			}
		};
		this.thoughtAnimationFrame = window.requestAnimationFrame(advance);
	}

	/** Streaming frames only touch the phase's own text, never the whole trace. */
	private updatePhaseText(phase: ThoughtPhase): void {
		if (!phase.el) {
			// First visible text for this phase: it needs a slot in the trace.
			this.renderSteps();
			return;
		}
		if (phase.renderedMarkdown) return;
		phase.el.setText(phase.displayedText);
		// While streaming, keep the newest line in view inside the clamped box.
		phase.el.scrollTop = phase.el.scrollHeight;
	}

	/** Once a phase is closed and fully shown, render it as Markdown exactly once. */
	private finalizePhaseIfDone(phase: ThoughtPhase): void {
		if (
			!phase.closed ||
			phase.renderedMarkdown ||
			!phase.el ||
			phase.displayedText.length < phase.receivedText.length
		) {
			return;
		}
		phase.renderedMarkdown = true;
		const el = phase.el;
		el.empty();
		el.removeClass('is-streaming');
		el.scrollTop = 0;
		const child = new Component();
		this.component.addChild(child);
		void MarkdownRenderer.render(this.app, phase.displayedText, el, '', child).then(() => {
			linkifyCodeWikilinks(this.app, el, '');
			this.updateClamp(phase);
		});
	}

	/** Long finished phases are clamped; clicking toggles the full text. */
	private updateClamp(phase: ThoughtPhase): void {
		const el = phase.el;
		if (!el || !phase.renderedMarkdown) return;
		if (phase.userExpanded) {
			el.removeClass('is-clamped');
			return;
		}
		// Height is only measurable while the trace is visible; re-checked on expand.
		if (!el.isShown()) return;
		el.toggleClass('is-clamped', el.scrollHeight > el.clientHeight + 4);
	}

	public settle(): void {
		this.closeOpenPhase();
		this.isSettled = true;
		this.endTime = performance.now();
		const durationSec = Math.max(
			1,
			Math.round(((this.endTime - this.startTime) / 1000) * 10) / 10,
		);

		const parts = this.buildSummary();
		parts.push({ text: parts.length ? ` (${durationSec}s)` : `Thought for ${durationSec}s` });
		this.summaryParts = parts;
		this.activeStatus = parts.map((p) => p.text).join('');

		this.isExpanded = false;
		this.updateHeader();
		this.renderSteps();
	}

	/** Show context the model got without a tool call, at the top of the trace. */
	public setAmbientContext(refs: ContextReference[]): void {
		const active = refs.find((r) => r.reason === 'Active note');
		if (!active) return;
		const selection = refs.find(
			(r) => r.reason === 'Selection' && r.path === active.path,
		);
		this.ambient = { path: active.path, selection: selection?.snippet };
		this.renderSteps();
	}

	/**
	 * Agent-style summary, e.g. "Read 2 notes, edited roadmap": one clause per
	 * kind of work, naming the note when there is exactly one.
	 */
	private buildSummary(): { text: string; file?: boolean }[] {
		const pathsOf = (names: string[]) => [
			...new Set(
				this.steps
					.filter((s) => names.includes(s.toolName))
					.map((s) => (typeof s.args?.path === 'string' ? s.args.path : s.secondary ?? ''))
					.filter(Boolean),
			),
		];
		const count = (names: string[]) =>
			this.steps.filter((s) => names.includes(s.toolName)).length;

		const clauses: { text: string; file?: boolean }[][] = [];
		const fileClause = (verb: string, paths: string[], noun = 'note') => {
			if (paths.length === 0) return;
			if (paths.length === 1) {
				clauses.push([{ text: `${verb} ` }, { text: basename(paths[0]) ?? '', file: true }]);
			} else {
				clauses.push([{ text: `${verb} ${paths.length} ${noun}s` }]);
			}
		};

		const searches = count(['search_notes']);
		if (searches) clauses.push([{ text: searches === 1 ? 'searched notes' : `searched notes ${searches} times` }]);
		const webSearches = count(['web_search', 'search_web']);
		if (webSearches) clauses.push([{ text: webSearches === 1 ? 'searched the web' : `searched the web ${webSearches} times` }]);
		if (count(['list_notes'])) clauses.push([{ text: 'listed notes' }]);
		fileClause('read', pathsOf(['read_note', 'get_note_outline']));
		fileClause('created', pathsOf(['create_note']));
		fileClause('edited', pathsOf(['edit_note', 'patch_note', 'replace_block', 'append_note', 'update_frontmatter']));
		const skills = this.steps
			.filter((s) => s.toolName === 'load_skill' && typeof s.args?.name === 'string')
			.map((s) => String(s.args?.name));
		if (skills.length === 1) clauses.push([{ text: 'loaded skill ' }, { text: skills[0] ?? '', file: true }]);
		else if (skills.length > 1) clauses.push([{ text: `loaded ${skills.length} skills` }]);

		const known = new Set([
			'search_notes', 'web_search', 'search_web', 'list_notes', 'read_note', 'get_note_outline',
			'create_note', 'edit_note', 'patch_note', 'replace_block', 'append_note', 'update_frontmatter',
			'load_skill', 'list_skills',
		]);
		const other = this.steps.filter((s) => !known.has(s.toolName)).length;
		if (other) clauses.push([{ text: `ran ${other} ${other === 1 ? 'tool' : 'tools'}` }]);

		const failed = this.steps.filter((s) => s.status === 'error').length;
		const parts: { text: string; file?: boolean }[] = [];
		clauses.forEach((clause, i) => {
			if (i > 0) parts.push({ text: ', ' });
			parts.push(...clause);
		});
		if (failed) parts.push({ text: ` · ${failed} failed` });
		const first = parts[0];
		if (first && !first.file) first.text = first.text.charAt(0).toUpperCase() + first.text.slice(1);
		return parts;
	}

	/** Resolve a model-supplied path to an existing vault note, if any. */
	private resolveNote(path: unknown): TFile | null {
		if (typeof path !== 'string' || !path) return null;
		return this.app.metadataCache.getFirstLinkpathDest(path.replace(/\.md$/, ''), '');
	}

	private formatToolStep(
		toolName: string,
		args: Record<string, unknown>,
	): { primary: string; secondary?: string; mono?: boolean } {
		const file = (primary: string) => ({
			primary,
			secondary: basename(args.path),
			mono: true,
		});
		switch (toolName) {
			case 'search_notes':
				return { primary: 'Search notes', secondary: quoted(args.query) };
			case 'web_search':
			case 'search_web':
				return { primary: 'Web search', secondary: quoted(args.query) };
			case 'list_notes':
				return {
					primary: 'List notes',
					secondary:
						typeof args.folder === 'string' && args.folder
							? args.folder
							: quoted(args.query),
					mono: typeof args.folder === 'string' && args.folder.length > 0,
				};
			case 'read_note':
				return file('Read');
			case 'get_note_outline':
				return file('Outline');
			case 'create_note':
				return file('Create');
			case 'edit_note':
			case 'patch_note':
				return file('Edit');
			case 'replace_block':
				return file('Replace block');
			case 'append_note':
				return file('Append');
			case 'update_frontmatter':
				return file('Update properties');
			case 'list_skills':
				return { primary: 'List skills' };
			case 'load_skill':
				return {
					primary: 'Load skill',
					secondary: typeof args.name === 'string' ? args.name : undefined,
					mono: true,
				};
			default: {
				// Unknown tools: sentence case, same file display as known ones.
				const words = toolName.replace(/[_-]+/g, ' ').trim();
				const primary = words.charAt(0).toUpperCase() + words.slice(1);
				return typeof args.path === 'string'
					? file(primary)
					: { primary, secondary: quoted(args.query) };
			}
		}
	}

	private render(): void {
		this.headerBtnEl = this.containerEl.createEl('button', {
			cls: 'anti-dian-thinking-header-btn',
			attr: {
				type: 'button',
				'aria-expanded': 'false',
			},
		});

		this.sparkleIconEl = this.headerBtnEl.createSpan({
			cls: 'anti-dian-thinking-sparkle-icon',
		});
		setIcon(this.sparkleIconEl, 'sparkles');

		this.statusTextEl = this.headerBtnEl.createSpan({
			cls: 'anti-dian-thinking-status-text is-shimmer',
			text: 'Thinking',
		});

		this.chevronIconEl = this.headerBtnEl.createSpan({
			cls: 'anti-dian-thinking-chevron-icon collapse-icon is-collapsed',
		});
		setIcon(this.chevronIconEl, 'right-triangle');

		this.headerBtnEl.onclick = (e) => {
			e.stopPropagation();
			this.isExpanded = !this.isExpanded;
			this.updateHeader();
			this.renderSteps();
		};

		// Trace collapsible container
		this.traceWrapperEl = this.containerEl.createDiv({
			cls: 'anti-dian-thinking-trace-wrapper',
		});

		this.traceContentEl = this.traceWrapperEl.createDiv({
			cls: 'anti-dian-thinking-trace-content',
		});

		this.guideLineEl = this.traceContentEl.createSpan({
			cls: 'anti-dian-thinking-guideline',
			attr: { 'aria-hidden': 'true' },
		});

		this.rowsContainerEl = this.traceContentEl.createDiv({
			cls: 'anti-dian-thinking-rows-container',
		});

		this.updateHeader();
	}

	private updateHeader(): void {
		this.headerBtnEl.setAttribute('aria-expanded', String(this.isExpanded));

		if (this.isSettled) {
			this.sparkleIconEl.removeClass('is-active');
			this.sparkleIconEl.addClass('is-settled');
			this.statusTextEl.removeClass('is-shimmer');
			this.statusTextEl.addClass('is-settled');
			this.statusTextEl.empty();
			for (const part of this.summaryParts ?? [{ text: this.activeStatus }]) {
				if (part.file) {
					this.statusTextEl.createSpan({ cls: 'anti-dian-thinking-status-file', text: part.text });
				} else {
					this.statusTextEl.appendText(part.text);
				}
			}
		} else {
			this.sparkleIconEl.addClass('is-active');
			this.sparkleIconEl.removeClass('is-settled');
			this.statusTextEl.addClass('is-shimmer');
			this.statusTextEl.removeClass('is-settled');
			this.statusTextEl.setText(this.activeStatus);
		}

		this.chevronIconEl.toggleClass('is-collapsed', !this.isExpanded);
		this.traceWrapperEl.toggleClass('is-open', this.isExpanded);
	}

	private renderSteps(): void {
		this.rowsContainerEl.empty();
		this.renderAmbientRow();

		if (this.steps.length === 0) {
			this.renderThoughtPhases(0);
			return;
		}

		for (let stepIndex = 0; stepIndex < this.steps.length; stepIndex++) {
			this.renderThoughtPhases(stepIndex);
			const step = this.steps[stepIndex];
			if (!step) continue;
			// Main Step Row
			const renderDetail = buildToolDetail(
				{
					toolName: step.toolName,
					status: step.status,
					args: step.args,
					output: step.output,
					error: step.error,
					fileDiff: step.fileDiff,
					sourceCount: step.sources?.length ?? 0,
				},
				{
					app: this.app,
					hoverParent: this.hoverParent,
					showRaw: this.getShowRawToolData(),
				},
			);
			const isOpen = renderDetail !== null && this.openStepIds.has(step.id);
			const row = this.rowsContainerEl.createDiv({
				cls: 'anti-dian-thinking-row',
			});
			row.toggleClass('is-expandable', renderDetail !== null);
			row.toggleClass('is-selected', isOpen);

			// Status icon
			if (step.status === 'running') {
				row.createSpan({ cls: 'anti-dian-thinking-row-spinner' });
			} else if (step.status === 'done') {
				const check = row.createSpan({ cls: 'anti-dian-thinking-row-check' });
				setIcon(check, 'check');
			} else {
				const errIcon = row.createSpan({ cls: 'anti-dian-thinking-row-err' });
				setIcon(errIcon, 'alert-circle');
			}

			// Primary label
			row.createSpan({
				cls: 'anti-dian-thinking-row-primary',
				text: step.primary,
			});

			// Secondary details: target note (as a link) or search query.
			const targetPath =
				typeof step.args?.path === 'string'
					? step.args.path
					: isRecord(step.output) && typeof step.output.path === 'string'
						? step.output.path
						: undefined;
			if (step.secondary && targetPath && step.mono) {
				this.renderFileLink(row, targetPath, step.secondary);
			} else if (step.secondary) {
				row.createSpan({
					cls: `anti-dian-thinking-row-secondary ${step.mono ? 'is-mono' : ''}`,
					text: step.secondary,
				});
			}

			// Diff stats
			if (step.add !== undefined || step.del !== undefined) {
				const diffSpan = row.createSpan({
					cls: 'anti-dian-thinking-row-diff',
				});
				if (step.add !== undefined) {
					diffSpan.createSpan({ cls: 'diff-add', text: `+${step.add}` });
				}
				if (step.del !== undefined) {
					diffSpan.createSpan({ cls: 'diff-del', text: ` −${step.del}` });
				}
			}

			// Only rows with something to show are expandable.
			if (renderDetail) {
				const chevron = row.createSpan({
					cls: `anti-dian-thinking-row-chevron collapse-icon ${isOpen ? '' : 'is-collapsed'}`,
				});
				setIcon(chevron, 'right-triangle');
				row.setAttribute('role', 'button');
				row.setAttribute('tabindex', '0');
				row.setAttribute('aria-expanded', String(isOpen));
				const toggle = () => {
					if (this.openStepIds.has(step.id)) this.openStepIds.delete(step.id);
					else this.openStepIds.add(step.id);
					this.renderSteps();
				};
				row.onclick = (e) => {
					e.stopPropagation();
					toggle();
				};
				row.onkeydown = (e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						toggle();
					}
				};
			}

			if (isOpen && renderDetail) {
				renderDetail(
					this.rowsContainerEl.createDiv({ cls: 'anti-dian-thinking-step-detail' }),
				);
			}

			// Render matching sources if search returned items
			if (step.sources && step.sources.length > 0) {
				const visibleSources = step.sources.slice(0, 3);
				for (const src of visibleSources) {
					const srcRow = this.rowsContainerEl.createEl(
						src.href ? 'a' : 'div',
						{
							cls: 'anti-dian-thinking-source-row',
							attr: src.href
								? { href: src.href, target: '_blank', rel: 'noopener noreferrer' }
								: {},
						},
					);

					// Grey source icon
					const iconSpan = srcRow.createSpan({
						cls: 'anti-dian-thinking-source-icon',
					});
					setIcon(iconSpan, src.href ? 'globe' : 'file-text');

					srcRow.createSpan({
						cls: 'anti-dian-thinking-source-title',
						text: src.title,
					});

					if (src.subtitle) {
						srcRow.createSpan({
							cls: 'anti-dian-thinking-source-subtitle',
							text: src.subtitle,
						});
					}

					// Vault notes behave like internal links (hover preview, mod-click).
					if (src.path && !src.href) {
						bindNoteLink(this.app, srcRow, {
							path: src.path,
							hoverParent: this.hoverParent,
						});
					}
				}

				if (step.sources.length > 3) {
					const moreSpan = this.rowsContainerEl.createSpan({
						cls: 'anti-dian-thinking-more-count',
					});
					moreSpan.setText(`+${step.sources.length - 3} more`);
				}
			}

		}
		this.renderThoughtPhases(this.steps.length);
	}

	private renderAmbientRow(): void {
		if (!this.ambient) return;
		const row = this.rowsContainerEl.createDiv({ cls: 'anti-dian-thinking-row' });
		const icon = row.createSpan({ cls: 'anti-dian-thinking-row-icon' });
		setIcon(icon, 'file-text');
		row.createSpan({ cls: 'anti-dian-thinking-row-primary', text: 'Active note' });
		this.renderFileLink(row, this.ambient.path, basename(this.ambient.path) ?? this.ambient.path);
		if (this.ambient.selection) {
			const sel = row.createSpan({
				cls: 'anti-dian-thinking-row-tag',
				text: '+ selection',
			});
			setTooltip(sel, this.ambient.selection, { placement: 'top' });
		}
	}

	/** File name in a row: an internal link when the note exists, plain text otherwise. */
	private renderFileLink(row: HTMLElement, path: unknown, label: string): void {
		const file = this.resolveNote(path);
		const el = row.createSpan({
			cls: 'anti-dian-thinking-row-secondary is-mono',
			text: label,
		});
		if (file) {
			el.addClass('is-link');
			bindNoteLink(this.app, el, { path: file.path, hoverParent: this.hoverParent });
		}
	}

	/**
	 * Attach each staged change's diff to the tool row that staged it and open
	 * those rows. With `expand`, the trace stays open so changes awaiting
	 * approval are visible without extra clicks.
	 */
	public attachChangeSetDiff(diff: ChangeSetDiff, expand: boolean): void {
		const staged = this.steps.filter((s) => isStagedMutation(s.toolName, s.output));
		staged.forEach((step, ordinal) => {
			const index =
				isRecord(step.output) && typeof step.output.operationIndex === 'number'
					? step.output.operationIndex
					: ordinal;
			const fileDiff = diff.files[index];
			if (!fileDiff) return;
			step.fileDiff = fileDiff;
			if (expand) this.openStepIds.add(step.id);
		});
		if (expand) this.isExpanded = true;
		this.updateHeader();
		this.renderSteps();
	}

	/** Open the trace and every staged change, and scroll it into view. */
	public revealChanges(): void {
		for (const step of this.steps) {
			if (step.fileDiff) this.openStepIds.add(step.id);
		}
		this.isExpanded = true;
		this.updateHeader();
		this.renderSteps();
		this.containerEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}

	private renderThoughtPhases(afterStep: number): void {
		for (const phase of this.thoughtPhases) {
			if (!phase.displayedText || phase.afterStep !== afterStep) continue;
			if (!phase.el) {
				const el = createDiv({
					cls: 'anti-dian-thinking-model-text is-streaming',
				});
				el.setText(phase.displayedText);
				el.onclick = (e) => {
					if (!el.hasClass('is-clamped') && !phase.userExpanded) return;
					e.stopPropagation();
					phase.userExpanded = !phase.userExpanded;
					el.toggleClass('is-expanded', phase.userExpanded);
					this.updateClamp(phase);
				};
				phase.el = el;
			}
			// Re-attach the same element: no re-render, no new Markdown children.
			this.rowsContainerEl.appendChild(phase.el);
			this.finalizePhaseIfDone(phase);
			this.updateClamp(phase);
		}
	}
}
