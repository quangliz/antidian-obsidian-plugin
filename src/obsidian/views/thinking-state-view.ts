import { App, Component, HoverParent, MarkdownRenderer, setIcon } from 'obsidian';
import { bindNoteLink } from './note-link';
import { AgentStepEvent } from '../../core/agent';

export interface SourceItem {
	title: string;
	subtitle?: string;
	href?: string;
	path?: string;
}

export interface ThinkingStep {
	id: string;
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
	private selectedStepId: string | null = null;

	constructor(
		containerEl: HTMLElement,
		app: App,
		component: Component,
		hoverParent?: HoverParent,
	) {
		this.hoverParent = hoverParent;
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
		void MarkdownRenderer.render(this.app, phase.displayedText, el, '', child).then(
			() => this.updateClamp(phase),
		);
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

		if (this.steps.length > 0) {
			const searchCount = this.steps.filter((s) => s.kind === 'search').length;
			const codeCount = this.steps.filter((s) => s.kind === 'code').length;

			if (searchCount > 0 && codeCount === 0) {
				const totalSources = this.steps.reduce((acc, s) => acc + (s.sources?.length || 0), 0);
				this.activeStatus = totalSources > 0
					? `Searched ${totalSources} ${totalSources === 1 ? 'source' : 'sources'} (${durationSec}s)`
					: `Searched (${durationSec}s)`;
			} else {
				const toolCount = this.steps.length;
				this.activeStatus = `Ran ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'} (${durationSec}s)`;
			}
		} else {
			this.activeStatus = `Thought for ${durationSec}s`;
		}

		this.isExpanded = false;
		this.updateHeader();
		this.renderSteps();
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
			this.statusTextEl.setText(this.activeStatus);
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

		if (this.steps.length === 0) {
			this.renderThoughtPhases(0);
			return;
		}

		for (let stepIndex = 0; stepIndex < this.steps.length; stepIndex++) {
			this.renderThoughtPhases(stepIndex);
			const step = this.steps[stepIndex];
			if (!step) continue;
			// Main Step Row
			const row = this.rowsContainerEl.createDiv({
				cls: `anti-dian-thinking-row ${this.selectedStepId === step.id ? 'is-selected' : ''}`,
			});

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

			// Secondary details (e.g. search query or target file)
			if (step.secondary) {
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

			// Click to toggle inspect args/error
			row.onclick = (e) => {
				e.stopPropagation();
				this.selectedStepId = this.selectedStepId === step.id ? null : step.id;
				this.renderSteps();
			};

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

			// Detail card if expanded
			if (this.selectedStepId === step.id && (step.args || step.error)) {
				const detailCard = this.rowsContainerEl.createDiv({
					cls: 'anti-dian-thinking-step-detail',
				});
				if (step.args && Object.keys(step.args).length > 0) {
					const argsList = detailCard.createDiv({
						cls: 'anti-dian-thinking-args-list',
					});
					for (const [k, v] of Object.entries(step.args)) {
						const valStr =
							typeof v === 'object' && v !== null
								? JSON.stringify(v)
								: String(v);
						argsList.createDiv({
							cls: 'anti-dian-thinking-arg-line',
							text: `${k}: ${valStr}`,
						});
					}
				}
				if (step.error) {
					detailCard.createDiv({
						cls: 'anti-dian-thinking-error-text',
						text: step.error,
					});
				}
			}
		}
		this.renderThoughtPhases(this.steps.length);
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
