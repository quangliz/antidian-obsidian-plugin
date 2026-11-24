import {
	App,
	Component,
	HoverParent,
	ButtonComponent,
	MarkdownRenderer,
	Modal,
	Notice,
	Setting,
	TFile,
	setIcon,
	setTooltip,
} from 'obsidian';
import type { ContextReference } from '../../core/types/context';
import type { FileDiff } from '../../core/types/changes';
import type { ApprovalDecision, ApprovalRequest } from '../../core/transactions';
import { bindNoteLink, linkifyCodeWikilinks } from './note-link';
import { buildToolDetail } from './tool-detail';
import { originalTextSize } from '../../core/sessions/trace';
import { ANTI_DIAN_ICON } from '../icon';
import { AgentStepEvent } from '../../core/agent';

/** One revolution of the thinking logo, in ms. */
const LOGO_SPIN_MS = 1200;

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
	status: 'running' | 'done' | 'error' | 'cancelled';
	sources?: SourceItem[];
	args?: Record<string, unknown>;
	output?: unknown;
	error?: string;
	/** Human-in-the-loop state for a write call. */
	approval?: StepApproval;
}

interface StepApproval {
	state: 'pending' | 'applied' | 'rejected' | 'undone';
	/** Resolves the agent's pending tool call (only while pending). */
	resolve?: (decision: ApprovalDecision) => void;
	appliedChangeSetId?: string;
	autoApproved?: boolean;
	busy?: boolean;
}

export interface ThinkingStateOptions {
	hoverParent?: HoverParent;
	getShowRawToolData?: () => boolean;
	/** Roll back one applied write (by its single-op ChangeSet id). */
	undoChange?: (changeSetId: string) => Promise<void>;
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
	/** Infinite logo spin while running; eased to a stop when the turn settles. */
	private logoSpin: Animation | null = null;
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
	private undoChange?: (changeSetId: string) => Promise<void>;

	constructor(
		containerEl: HTMLElement,
		app: App,
		component: Component,
		options: ThinkingStateOptions = {},
	) {
		this.hoverParent = options.hoverParent;
		this.getShowRawToolData = options.getShowRawToolData ?? (() => false);
		this.undoChange = options.undoChange;
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
				this.applyReviewOutcome(current, step.toolOutput);
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
		} else if (step.type === 'cancelled') {
			this.activeStatus = 'Stopped';
			this.updateHeader();
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

	/**
	 * Finishes the trace. `replayed` marks a turn rebuilt from a stored session:
	 * its duration is unknown, and calls that never finished are shown as stopped.
	 */
	public settle(options?: {
		cancelled?: boolean;
		replayed?: boolean;
		/** Original duration of a replayed turn, when it was saved. */
		durationMs?: number;
	}): void {
		const cancelled = options?.cancelled === true;
		const replayed = options?.replayed === true;
		if (this.thoughtAnimationFrame !== null) {
			window.cancelAnimationFrame(this.thoughtAnimationFrame);
			this.thoughtAnimationFrame = null;
		}
		for (const phase of this.thoughtPhases) {
			if (!cancelled && phase.displayedText.length < phase.receivedText.length) {
				phase.displayedText = phase.receivedText;
			}
			phase.closed = true;
		}
		for (const resolve of this.thoughtWaiters.splice(0)) resolve();

		if (cancelled || replayed) {
			this.cancelPendingApprovals();
			for (const step of this.steps) {
				if (step.status === 'running') {
					step.status = 'cancelled';
				}
			}
		}

		this.closeOpenPhase();
		this.isSettled = true;
		this.endTime = performance.now();
		const elapsedMs = options?.durationMs ?? this.endTime - this.startTime;
		const durationSec = Math.max(1, Math.round((elapsedMs / 1000) * 10) / 10);

		const parts = this.buildSummary(cancelled);
		if (replayed && options?.durationMs === undefined) {
			if (!parts.length) parts.push({ text: 'Thought' });
		} else {
			parts.push({
				text: parts.length
					? ` (${durationSec}s)`
					: cancelled
						? `Stopped (${durationSec}s)`
						: `Thought for ${durationSec}s`,
			});
		}
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
	private buildSummary(cancelled = false): { text: string; file?: boolean }[] {
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
		const writeTools = ['edit_note', 'patch_note', 'replace_block', 'append_note', 'update_frontmatter'];
		fileClause(
			'edited',
			[
				...new Set(
					this.steps
						.filter(
							(s) =>
								writeTools.includes(s.toolName) &&
								(s.approval === undefined || s.approval.state === 'applied'),
						)
						.map((s) => (typeof s.args?.path === 'string' ? s.args.path : s.secondary ?? ''))
						.filter(Boolean),
				),
			],
		);
		const rejected = this.steps.filter((s) => s.approval?.state === 'rejected').length;
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
		if (rejected) parts.push({ text: ` · ${rejected} rejected` });
		if (failed) parts.push({ text: ` · ${failed} failed` });
		if (cancelled && parts.length > 0) parts.push({ text: ' · stopped' });
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
		// Anti-dian logo; spins around its vertical axis while the turn is running.
		setIcon(this.sparkleIconEl, ANTI_DIAN_ICON);

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

	private startLogoSpin(): void {
		if (this.logoSpin?.playState === 'running') return;
		const svg = this.sparkleIconEl.querySelector('svg');
		if (!svg || svg.win.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		this.logoSpin?.cancel();
		this.logoSpin = svg.animate(
			[
				{ transform: `perspective(120px) rotateY(0deg)` },
				{ transform: `perspective(120px) rotateY(360deg)` },
			],
			{ duration: LOGO_SPIN_MS, iterations: Infinity, easing: 'linear' },
		);
	}

	/**
	 * Replace the endless spin with one that starts at the current angle and speed
	 * and decelerates to rest facing front.
	 */
	private spinDownLogo(): void {
		const spin = this.logoSpin;
		this.logoSpin = null;
		if (!spin || spin.playState !== 'running') {
			spin?.cancel();
			return;
		}
		const svg = this.sparkleIconEl.querySelector('svg');
		const elapsed = Number(spin.currentTime ?? 0);
		spin.cancel();
		// Traces replayed from a resumed session settle right away: no spin-down.
		if (!svg || elapsed < 250) return;

		const angle = ((elapsed % LOGO_SPIN_MS) / LOGO_SPIN_MS) * 360;
		let remaining = 360 - angle;
		// Too little left to slow down gracefully: coast through one more turn.
		if (remaining < 180) remaining += 360;
		// The easing starts at slope 2, so this duration matches the spin speed at handoff.
		const degPerMs = 360 / LOGO_SPIN_MS;
		const duration = (2 * remaining) / degPerMs;
		svg.animate(
			[
				{ transform: `perspective(120px) rotateY(${angle}deg)` },
				{ transform: `perspective(120px) rotateY(${angle + remaining}deg)` },
			],
			{ duration, easing: 'cubic-bezier(0.25, 0.5, 0.25, 1)' },
		);
	}

	private updateHeader(): void {
		this.headerBtnEl.setAttribute('aria-expanded', String(this.isExpanded));

		if (this.isSettled) {
			this.spinDownLogo();
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
			this.startLogoSpin();
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
					status: step.status === 'cancelled' ? 'done' : step.status,
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
			const hasApprovalControls =
				step.approval?.state === 'pending' ||
				(step.approval?.state === 'applied' &&
					Boolean(step.approval.appliedChangeSetId) &&
					Boolean(this.undoChange));
			const hasPanel = renderDetail !== null || hasApprovalControls;
			const isOpen = hasPanel && this.openStepIds.has(step.id);
			const row = this.rowsContainerEl.createDiv({
				cls: 'anti-dian-thinking-row',
			});
			row.toggleClass('is-expandable', hasPanel);
			row.toggleClass('is-selected', isOpen);

			// Status icon
			if (step.approval?.state === 'pending') {
				const wait = row.createSpan({ cls: 'anti-dian-thinking-row-await' });
				setIcon(wait, 'hand');
			} else if (step.status === 'running') {
				row.createSpan({ cls: 'anti-dian-thinking-row-spinner' });
			} else if (step.status === 'done') {
				const check = row.createSpan({ cls: 'anti-dian-thinking-row-check' });
				setIcon(check, 'check');
			} else if (step.status === 'cancelled') {
				const stopIcon = row.createSpan({ cls: 'anti-dian-thinking-row-cancelled' });
				setIcon(stopIcon, 'ban');
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

			// Compact inline stats for plain read_note calls (no expand button needed)
			const readMeta = this.formatReadNoteInlineMeta(step);
			if (readMeta) {
				row.createSpan({
					cls: 'anti-dian-thinking-row-secondary',
					text: readMeta,
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

			// Outcome tag for writes, visible even when the row is collapsed.
			if (step.approval) {
				const label = {
					pending: 'Needs approval',
					applied: step.approval.autoApproved ? 'Auto-applied' : 'Applied',
					rejected: 'Rejected',
					undone: 'Undone',
				}[step.approval.state];
				row.createSpan({
					cls: `anti-dian-thinking-row-tag is-${step.approval.state}`,
					text: label,
				});
			}

			// Only rows with something to show are expandable.
			if (hasPanel) {
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

			if (isOpen) {
				const panel = this.rowsContainerEl.createDiv({ cls: 'anti-dian-thinking-step-detail' });
				renderDetail?.(panel);
				this.renderApprovalControls(panel, step);
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
	private formatReadNoteInlineMeta(step: ThinkingStep): string | null {
		if (step.toolName !== 'read_note' || step.status !== 'done') return null;
		if (!isRecord(step.output)) return null;
		const content =
			typeof step.output.content === 'string' ? step.output.content : undefined;
		const size = originalTextSize(step.output, 'content');
		if (content === undefined && !size) return null;

		const lines =
			size?.lines ?? (content ? content.split('\n').length : 0);
		const chars = size?.chars ?? (content?.length ?? 0);
		const heading =
			typeof step.output.heading === 'string' && step.output.heading.trim()
				? `#${step.output.heading.trim()}`
				: undefined;
		const parts: string[] = [];
		if (heading) parts.push(heading);
		parts.push(`${lines.toLocaleString()} line${lines === 1 ? '' : 's'}`);
		if (chars > 0) {
			const charLabel =
				chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars);
			parts.push(`${charLabel} chars`);
		}
		return `· ${parts.join(' · ')}`;
	}

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
	 * Ask mode: show the write's diff on its tool row with Approve / Reject and
	 * wait. The agent's tool call (and the model) stays paused until decided.
	 */
	public requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
		const step =
			this.steps.find((s) => s.callId === request.callId) ??
			[...this.steps].reverse().find(
				(s) => s.toolName === request.toolName && s.status === 'running',
			);
		if (!step) return Promise.resolve('reject');

		return new Promise<ApprovalDecision>((resolve) => {
			step.fileDiff = request.diff;
			step.approval = {
				state: 'pending',
				resolve: (decision) => {
					step.approval = { state: decision === 'approve' ? 'applied' : 'rejected' };
					this.activeStatus = 'Thinking';
					this.updateHeader();
					this.renderSteps();
					resolve(decision);
				},
			};
			this.openStepIds.add(step.id);
			this.isExpanded = true;
			this.activeStatus = 'Waiting for approval';
			this.updateHeader();
			this.renderSteps();
			this.containerEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		});
	}

	/** Resolve a specific pending approval externally (e.g. from inline editor diff). */
	public resolveApproval(callId: string, decision: ApprovalDecision): boolean {
		const step = this.steps.find(
			(s) => s.callId === callId && s.approval?.state === 'pending',
		);
		if (!step?.approval?.resolve) return false;
		step.approval.resolve(decision);
		return true;
	}

	/** True if this turn has at least one applied edit that can be undone. */
	public hasUndoableChanges(): boolean {
		return (
			Boolean(this.undoChange) &&
			this.steps.some(
				(s) =>
					s.approval?.state === 'applied' &&
					Boolean(s.approval.appliedChangeSetId),
			)
		);
	}

	/** Undoes every applied edit from this turn in reverse (LIFO) order. */
	public async undoAllApplied(): Promise<number> {
		if (!this.undoChange) return 0;
		const targets = [...this.steps]
			.reverse()
			.filter(
				(s) =>
					s.approval?.state === 'applied' &&
					Boolean(s.approval.appliedChangeSetId),
			);
		if (targets.length === 0) return 0;

		const confirmed = await confirmAction(this.app, {
			title:
				targets.length === 1
					? 'Undo this change?'
					: `Undo ${targets.length} changes from this turn?`,
			message:
				'This restores the affected note(s) to how they were before this turn. Later edits to the same note may be lost.',
			cta: 'Undo',
		});
		if (!confirmed) return 0;

		let reverted = 0;
		for (const step of targets) {
			const id = step.approval?.appliedChangeSetId;
			if (!id || !step.approval) continue;
			step.approval.busy = true;
			this.renderSteps();
			try {
				await this.undoChange(id);
				step.approval = { state: 'undone' };
				reverted++;
			} catch (err) {
				step.approval.busy = false;
				new Notice(
					`Undo failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				break;
			}
		}
		this.renderSteps();
		return reverted;
	}

	/** Reject every write still waiting (view closed or session reset). */
	public cancelPendingApprovals(): void {
		for (const step of this.steps) {
			if (step.approval?.state === 'pending') step.approval.resolve?.('reject');
		}
	}

	/** Read the gate's outcome (applied / rejected) from the tool's final output. */
	private applyReviewOutcome(step: ThinkingStep, output: unknown): void {
		if (!isRecord(output)) return;
		if (isRecord(output._diff)) step.fileDiff = output._diff as unknown as FileDiff;
		if (output.applied === true) {
			step.approval = {
				state: 'applied',
				appliedChangeSetId:
					typeof output.appliedChangeSetId === 'string' ? output.appliedChangeSetId : undefined,
				autoApproved: output.autoApproved === true,
			};
		} else if (output.rejectedByUser === true) {
			step.approval = { state: 'rejected' };
		}
	}

	/** Approve / Reject while pending; Applied + Undo or Rejected afterwards. */
	private renderApprovalControls(parent: HTMLElement, step: ThinkingStep): void {
		const approval = step.approval;
		if (!approval) return;
		const bar = parent.createDiv({ cls: 'anti-dian-approval-bar' });

		if (approval.state === 'pending') {
			bar.addClass('is-pending');
			bar.createSpan({ cls: 'anti-dian-approval-label', text: 'Apply this change?' });
			const actions = bar.createDiv({ cls: 'anti-dian-approval-actions' });
			new ButtonComponent(actions)
				.setButtonText('Reject')
				.onClick(() => approval.resolve?.('reject'));
			new ButtonComponent(actions)
				.setCta()
				.setButtonText('Approve')
				.onClick(() => approval.resolve?.('approve'));
			return;
		}

		if (approval.state === 'rejected') {
			bar.createSpan({ cls: 'anti-dian-approval-status', text: 'Rejected' });
			return;
		}
		if (approval.state === 'undone') {
			bar.createSpan({ cls: 'anti-dian-approval-status', text: 'Undone' });
			return;
		}

		bar.createSpan({
			cls: 'anti-dian-approval-status is-applied',
			text: approval.autoApproved ? 'Applied automatically' : 'Applied',
		});
		const changeSetId = approval.appliedChangeSetId;
		if (changeSetId && this.undoChange) {
			new ButtonComponent(bar.createDiv({ cls: 'anti-dian-approval-actions' }))
				.setIcon('undo')
				.setTooltip('Undo this change')
				.setDisabled(approval.busy === true)
				.onClick(() => void this.undoStep(step, changeSetId));
		}
	}

	private async undoStep(step: ThinkingStep, changeSetId: string): Promise<void> {
		const name = step.secondary ?? 'this note';
		const confirmed = await confirmAction(this.app, {
			title: 'Undo this change?',
			message: `This restores ${name} to how it was before this change. Later changes to the same note may be lost.`,
			cta: 'Undo',
		});
		if (!confirmed || !this.undoChange || !step.approval) return;
		step.approval.busy = true;
		this.renderSteps();
		try {
			await this.undoChange(changeSetId);
			step.approval = { state: 'undone' };
		} catch (err) {
			step.approval.busy = false;
			new Notice(`Undo failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		this.renderSteps();
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

interface ConfirmOptions {
	title: string;
	message: string;
	cta: string;
}

/** Native confirmation dialog; resolves true only when the CTA is pressed. */
function confirmAction(app: App, opts: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		let confirmed = false;
		const modal = new Modal(app);
		modal.setTitle(opts.title);
		modal.contentEl.createEl('p', { text: opts.message });
		new Setting(modal.contentEl)
			.addButton((btn) => btn.setButtonText('Cancel').onClick(() => modal.close()))
			.addButton((btn) =>
				btn
					.setButtonText(opts.cta)
					.setWarning()
					.onClick(() => {
						confirmed = true;
						modal.close();
					}),
			);
		modal.onClose = () => resolve(confirmed);
		modal.open();
	});
}
