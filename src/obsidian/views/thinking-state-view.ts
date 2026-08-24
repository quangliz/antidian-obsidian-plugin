import { setIcon } from 'obsidian';
import { AgentStepEvent } from '../../core/agent';

export interface ThinkingStep {
	id: string;
	toolName: string;
	primary: string;
	secondary?: string;
	mono?: boolean;
	add?: number;
	del?: number;
	status: 'running' | 'done' | 'error';
	args?: Record<string, unknown>;
	output?: unknown;
	error?: string;
}

export class ThinkingStateView {
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
	private activeStepName = 'Thinking';
	private selectedStepId: string | null = null;

	constructor(containerEl: HTMLElement) {
		this.containerEl = containerEl.createDiv({
			cls: 'anti-dian-thinking-state',
		});
		this.startTime = performance.now();
		this.render();
	}

	public handleStep(step: AgentStepEvent): void {
		if (step.type === 'thinking') {
			this.activeStepName = 'Thinking';
			this.updateHeader();
		} else if (step.type === 'tool_start') {
			const formatted = this.formatToolStep(step.toolName, step.toolArgs);
			const newStep: ThinkingStep = {
				id: `step_${this.steps.length + 1}`,
				toolName: step.toolName,
				primary: formatted.primary,
				secondary: formatted.secondary,
				mono: formatted.mono,
				status: 'running',
				args: step.toolArgs,
			};
			this.steps.push(newStep);
			this.activeStepName = `Running ${formatted.primary.toLowerCase()}...`;
			// Auto expand when tools start running
			this.isExpanded = true;
			this.updateHeader();
			this.renderSteps();
		} else if (step.type === 'tool_end') {
			const current = this.steps.find(
				(s) => s.toolName === step.toolName && s.status === 'running',
			) || this.steps[this.steps.length - 1];

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

				// Check for diff/changeset metrics if tool was patch/create
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
			this.activeStepName = 'Thinking...';
			this.updateHeader();
			this.renderSteps();
		} else if (step.type === 'error') {
			this.activeStepName = `Error: ${step.message}`;
			this.updateHeader();
		}
	}

	public settle(): void {
		this.isSettled = true;
		this.endTime = performance.now();
		const durationSec = Math.max(
			1,
			Math.round(((this.endTime - this.startTime) / 1000) * 10) / 10,
		);

		if (this.steps.length > 0) {
			const toolCount = this.steps.length;
			this.activeStepName = `Ran ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'} (${durationSec}s)`;
		} else {
			this.activeStepName = `Thought for ${durationSec}s`;
		}

		// By default collapse when settled to keep the response clean, but leave expandable
		this.isExpanded = false;
		this.updateHeader();
		this.renderSteps();
	}

	private formatToolStep(
		toolName: string,
		args: Record<string, unknown>,
	): { primary: string; secondary?: string; mono?: boolean } {
		switch (toolName) {
			case 'search_notes':
				return {
					primary: 'Search notes',
					secondary: typeof args.query === 'string' ? `"${args.query}"` : undefined,
				};
			case 'read_note':
				return {
					primary: 'Read',
					secondary: typeof args.path === 'string' ? args.path.replace(/\.md$/, '').split('/').pop() : undefined,
					mono: true,
				};
			case 'create_note':
				return {
					primary: 'Create',
					secondary: typeof args.path === 'string' ? args.path.replace(/\.md$/, '').split('/').pop() : undefined,
					mono: true,
				};
			case 'patch_note':
				return {
					primary: 'Edit',
					secondary: typeof args.path === 'string' ? args.path.replace(/\.md$/, '').split('/').pop() : undefined,
					mono: true,
				};
			case 'web_search':
				return {
					primary: 'Web search',
					secondary: typeof args.query === 'string' ? `"${args.query}"` : undefined,
				};
			default:
				return {
					primary: toolName.replace(/_/g, ' '),
					secondary: typeof args.path === 'string' ? args.path : undefined,
				};
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
			text: 'Thinking...',
		});

		this.chevronIconEl = this.headerBtnEl.createSpan({
			cls: 'anti-dian-thinking-chevron-icon',
		});
		setIcon(this.chevronIconEl, 'chevron-down');

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
			this.statusTextEl.setText(this.activeStepName);
		} else {
			this.sparkleIconEl.addClass('is-active');
			this.sparkleIconEl.removeClass('is-settled');
			this.statusTextEl.addClass('is-shimmer');
			this.statusTextEl.removeClass('is-settled');
			this.statusTextEl.setText(this.activeStepName);
		}

		if (this.isExpanded) {
			this.chevronIconEl.addClass('is-rotated');
			this.traceWrapperEl.addClass('is-open');
		} else {
			this.chevronIconEl.removeClass('is-rotated');
			this.traceWrapperEl.removeClass('is-open');
		}
	}

	private renderSteps(): void {
		this.rowsContainerEl.empty();

		if (this.steps.length === 0) {
			if (!this.isSettled) {
				const row = this.rowsContainerEl.createDiv({
					cls: 'anti-dian-thinking-row',
				});
				const spinner = row.createSpan({
					cls: 'anti-dian-thinking-row-spinner',
				});
				spinner.setAttribute('aria-hidden', 'true');
				row.createSpan({
					cls: 'anti-dian-thinking-row-primary',
					text: 'Reasoning about prompt context...',
				});
			}
			return;
		}

		for (const step of this.steps) {
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

			// Secondary details
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
					diffSpan.createSpan({ cls: 'diff-del', text: ` -${step.del}` });
				}
			}

			// Click to toggle inspect args/error
			row.onclick = (e) => {
				e.stopPropagation();
				this.selectedStepId = this.selectedStepId === step.id ? null : step.id;
				this.renderSteps();
			};

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
	}
}
