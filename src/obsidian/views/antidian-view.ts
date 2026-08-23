import {
	ItemView,
	MarkdownRenderer,
	WorkspaceLeaf,
	setIcon,
} from 'obsidian';
import type AntiDianPlugin from '../../main';
import {
	ActiveContext,
	ContextReference,
	ContextService,
} from '../../core/types/context';
import { Agent, AgentStepEvent } from '../../core/agent';
import { Message } from '../../core/types/model';
import { ChangeSet } from '../../core/types/changes';
import { ChangeSetValidator } from '../../core/transactions';
import {
	fetchAvailableModels,
	formatTokens,
	AvailableModel,
	ModelGroup,
} from '../../core/models/antigravity-oauth';

export const ANTI_DIAN_VIEW_TYPE = 'anti-dian-sidebar';

interface ActionItem {
	id: string;
	name: string;
	args: Record<string, unknown>;
	output?: unknown;
	status: 'running' | 'done' | 'error';
	error?: string;
}

export class AntiDianView extends ItemView {
	private plugin: AntiDianPlugin;
	private contextService: ContextService;
	private agent: Agent;
	private validator?: ChangeSetValidator;
	private unsubscribeContext: (() => void) | null = null;
	private contextBoxEl: HTMLElement | null = null;
	private modelInfoEl: HTMLElement | null = null;
	private modelSelectEl: HTMLSelectElement | null = null;
	private effortSelectEl: HTMLSelectElement | null = null;
	private availableModels: AvailableModel[] = [];
	private modelGroups: ModelGroup[] = [];
	private inputEl: HTMLTextAreaElement | null = null;
	private sendButtonEl: HTMLButtonElement | null = null;
	private messagesEl: HTMLElement | null = null;
	private history: Message[] = [];
	private isRunning = false;

	constructor(
		leaf: WorkspaceLeaf,
		plugin: AntiDianPlugin,
	) {
		super(leaf);
		this.plugin = plugin;
		this.contextService = plugin.workspaceAdapter;
		this.agent = plugin.agent;
		this.validator = plugin.validator;
	}

	getViewType(): string {
		return ANTI_DIAN_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Anti-dian';
	}

	getIcon(): string {
		return 'bot';
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass('anti-dian-sidebar-container');

		this.renderHeader(container);
		this.renderContextBox(container);
		this.renderBody(container);
		this.renderInputArea(container);

		this.unsubscribeContext = this.contextService.onContextChange(
			(context) => {
				this.updateContextUI(context);
			},
		);

		void this.loadModels();
	}

	async onClose(): Promise<void> {
		if (this.unsubscribeContext) {
			this.unsubscribeContext();
			this.unsubscribeContext = null;
		}
		this.contentEl.empty();
	}

	private renderHeader(parent: HTMLElement): void {
		const headerEl = parent.createDiv({ cls: 'anti-dian-header' });

		const titleRow = headerEl.createDiv({ cls: 'anti-dian-title-row' });
		const leftGroup = titleRow.createDiv({ cls: 'anti-dian-title-left' });

		leftGroup.createEl('img', {
			cls: 'anti-dian-logo-img',
			attr: {
				src: this.getLogoUrl(),
				alt: 'Anti-dian',
			},
		});

		leftGroup.createSpan({
			text: 'Anti-dian',
			cls: 'anti-dian-title',
		});

		const rightGroup = titleRow.createDiv({ cls: 'anti-dian-title-right' });
		this.modelSelectEl = rightGroup.createEl('select', {
			cls: 'anti-dian-model-picker-select',
		});

		this.effortSelectEl = rightGroup.createEl('select', {
			cls: 'anti-dian-effort-picker-select anti-dian-hidden',
		});

		const opt = this.modelSelectEl.createEl('option', {
			text: this.plugin.settings.model ?? 'Loading models...',
			value: this.plugin.settings.model ?? '',
		});
		opt.selected = true;

		this.modelSelectEl.onchange = () => {
			this.onModelGroupChange();
		};

		this.effortSelectEl.onchange = () => {
			this.onEffortChange();
		};

		this.modelInfoEl = headerEl.createDiv({
			cls: 'anti-dian-model-info-bar',
		});
		this.updateModelInfoDisplay(this.plugin.settings.model);
	}

	private onModelGroupChange(): void {
		const selectedBase = this.modelSelectEl?.value;
		const group = this.modelGroups.find((g) => g.baseName === selectedBase);
		if (!group) return;

		this.populateEffortOptions(group);

		const firstVariant =
			group.variants.find(
				(v) => v.thinkingEffort.toLowerCase() === 'high',
			) ?? group.variants[0];

		if (firstVariant) {
			if (this.effortSelectEl) {
				this.effortSelectEl.value = firstVariant.thinkingEffort;
			}
			this.setActiveModel(
				firstVariant.id,
				group,
				firstVariant.thinkingEffort,
			);
		}
	}

	private onEffortChange(): void {
		const selectedBase = this.modelSelectEl?.value;
		const selectedEffort = this.effortSelectEl?.value;
		const group = this.modelGroups.find((g) => g.baseName === selectedBase);
		if (!group) return;

		const variant =
			group.variants.find((v) => v.thinkingEffort === selectedEffort) ??
			group.variants[0];

		if (variant) {
			this.setActiveModel(variant.id, group, variant.thinkingEffort);
		}
	}

	private populateEffortOptions(
		group: ModelGroup,
		currentEffort?: string,
	): void {
		if (!this.effortSelectEl) return;
		this.effortSelectEl.empty();

		if (group.variants.length > 1) {
			this.effortSelectEl.removeClass('anti-dian-hidden');
			for (const v of group.variants) {
				const opt = this.effortSelectEl.createEl('option', {
					text: `🧠 ${v.thinkingEffort}`,
					value: v.thinkingEffort,
				});
				if (
					currentEffort &&
					v.thinkingEffort.toLowerCase() ===
						currentEffort.toLowerCase()
				) {
					opt.selected = true;
				}
			}
		} else {
			this.effortSelectEl.addClass('anti-dian-hidden');
		}
	}

	private setActiveModel(
		modelId: string,
		group?: ModelGroup,
		effort?: string,
	): void {
		this.plugin.settings.model = modelId;
		this.plugin.geminiProvider.setModel(modelId);
		void this.plugin.saveSettings();
		this.updateModelInfoDisplay(modelId, group, effort);
	}

	private async loadModels(): Promise<void> {
		try {
			const { models, groups, defaultModelId } =
				await fetchAvailableModels();
			this.availableModels = models;
			this.modelGroups = groups;

			const currentModelId =
				this.plugin.settings.model ||
				defaultModelId ||
				'gemini-3.7-flash-high';

			let activeGroup = groups.find((g) =>
				g.variants.some((v) => v.id === currentModelId),
			);
			if (!activeGroup && groups.length > 0) {
				activeGroup = groups[0];
			}

			if (this.modelSelectEl) {
				this.modelSelectEl.empty();
				for (const g of groups) {
					const ctxLabel = g.maxTokens
						? ` (${formatTokens(g.maxTokens)})`
						: '';
					const option = this.modelSelectEl.createEl('option', {
						text: `${g.baseName}${ctxLabel}`,
						value: g.baseName,
					});
					if (activeGroup && g.baseName === activeGroup.baseName) {
						option.selected = true;
					}
				}
			}

			if (activeGroup) {
				const activeVariant =
					activeGroup.variants.find((v) => v.id === currentModelId) ??
					activeGroup.variants[0];
				const currentEffort = activeVariant?.thinkingEffort;
				this.populateEffortOptions(activeGroup, currentEffort);
				this.updateModelInfoDisplay(
					currentModelId,
					activeGroup,
					currentEffort,
				);
			}
		} catch {
			if (this.modelInfoEl) {
				this.modelInfoEl.empty();
				const badge = this.modelInfoEl.createSpan({
					cls: 'anti-dian-model-chip',
				});
				badge.setText(
					this.plugin.settings.model ?? 'gemini-3.7-flash-high',
				);
			}
		}
	}

	private updateModelInfoDisplay(
		modelId?: string,
		group?: ModelGroup,
		effort?: string,
	): void {
		if (!this.modelInfoEl) return;
		this.modelInfoEl.empty();

		const modelInfo = this.availableModels.find((m) => m.id === modelId);
		const maxTokens = group?.maxTokens ?? modelInfo?.maxTokens;

		const chipContainer = this.modelInfoEl.createDiv({
			cls: 'anti-dian-model-chips',
		});

		if (maxTokens) {
			const tokenChip = chipContainer.createSpan({
				cls: 'anti-dian-model-chip anti-dian-chip-ctx',
			});
			tokenChip.setText(`⚡ ${formatTokens(maxTokens)} context`);
		}

		if (effort && effort !== 'Default') {
			const thinkChip = chipContainer.createSpan({
				cls: 'anti-dian-model-chip anti-dian-chip-think',
			});
			thinkChip.setText(`🧠 Effort: ${effort}`);
		} else if (group?.supportsThinking || modelInfo?.supportsThinking) {
			const thinkChip = chipContainer.createSpan({
				cls: 'anti-dian-model-chip anti-dian-chip-think',
			});
			thinkChip.setText('🧠 Thinking');
		}

		const authChip = chipContainer.createSpan({
			cls: 'anti-dian-model-chip anti-dian-chip-auth',
		});
		authChip.setText('🔑 Connected');
	}

	private renderContextBox(parent: HTMLElement): void {
		this.contextBoxEl = parent.createDiv({ cls: 'anti-dian-context-box' });
		this.updateContextUI(this.contextService.getActiveContext());
	}

	private updateContextUI(context: ActiveContext): void {
		if (!this.contextBoxEl) {
			return;
		}
		this.contextBoxEl.empty();

		const titleRow = this.contextBoxEl.createDiv({
			cls: 'anti-dian-context-header',
		});
		titleRow.createSpan({ text: 'Context' });

		const bodyRow = this.contextBoxEl.createDiv({
			cls: 'anti-dian-context-body',
		});

		if (context.activeFile) {
			const noteName = context.activeFile
				.replace(/\.md$/, '')
				.split('/')
				.pop();
			bodyRow.createDiv({
				text: `[[${noteName}]]`,
				cls: 'anti-dian-context-file',
			});

			if (context.selection) {
				const charCount = context.selection.length;
				bodyRow.createDiv({
					text: `Selection: ${charCount} ${charCount === 1 ? 'char' : 'chars'}`,
					cls: 'anti-dian-context-selection',
				});
			}
		} else {
			bodyRow.createDiv({
				text: 'No active note',
				cls: 'anti-dian-context-empty',
			});
		}
	}

	private renderBody(parent: HTMLElement): void {
		this.messagesEl = parent.createDiv({ cls: 'anti-dian-messages' });

		const emptyState = this.messagesEl.createDiv({
			cls: 'anti-dian-empty-state',
		});

		emptyState.createEl('img', {
			cls: 'anti-dian-empty-logo-img',
			attr: {
				src: this.getLogoUrl(),
				alt: 'Anti-dian',
			},
		});

		emptyState.createEl('h4', {
			text: 'Anti-dian assistant',
			cls: 'anti-dian-empty-title',
		});

		emptyState.createEl('p', {
			text: 'Chat with your vault, ask questions, or synthesize notes.',
			cls: 'anti-dian-empty-desc',
		});

		const suggestionsEl = emptyState.createDiv({
			cls: 'anti-dian-suggestions',
		});

		const suggestions = [
			'Summarize active note',
			'Find related notes',
			'Extract action items',
		];

		for (const prompt of suggestions) {
			const pill = suggestionsEl.createEl('button', {
				text: prompt,
				cls: 'anti-dian-suggestion-pill',
			});
			pill.onclick = () => {
				if (this.inputEl) {
					this.inputEl.value = prompt;
					void this.handleSend();
				}
			};
		}
	}

	private renderInputArea(parent: HTMLElement): void {
		const inputContainer = parent.createDiv({
			cls: 'anti-dian-input-container',
		});

		this.inputEl = inputContainer.createEl('textarea', {
			cls: 'anti-dian-input',
			attr: {
				placeholder: 'Ask anti-dian...',
				rows: '2',
			},
		});

		const controlsRow = inputContainer.createDiv({
			cls: 'anti-dian-controls-row',
		});

		this.sendButtonEl = controlsRow.createEl('button', {
			cls: 'anti-dian-send-button mod-cta',
			attr: { 'aria-label': 'Send message' },
		});
		setIcon(this.sendButtonEl, 'send');

		this.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void this.handleSend();
			}
		});

		this.sendButtonEl.onclick = () => {
			void this.handleSend();
		};
	}

	private async handleSend(): Promise<void> {
		if (!this.inputEl || !this.messagesEl || this.isRunning) {
			return;
		}

		const text = this.inputEl.value.trim();
		if (!text) {
			return;
		}

		this.isRunning = true;
		if (this.sendButtonEl) {
			this.sendButtonEl.disabled = true;
		}

		const emptyState = this.messagesEl.querySelector(
			'.anti-dian-empty-state',
		);
		if (emptyState) {
			emptyState.remove();
		}

		const userMsg = this.messagesEl.createDiv({
			cls: 'anti-dian-message anti-dian-message-user',
		});
		userMsg.createEl('p', { text });

		this.inputEl.value = '';
		this.scrollToBottom();

		const agentMsg = this.messagesEl.createDiv({
			cls: 'anti-dian-message anti-dian-message-agent',
		});

		const actionsContainer = agentMsg.createDiv({
			cls: 'anti-dian-actions-container',
		});
		const liveStatusEl = agentMsg.createDiv({
			cls: 'anti-dian-live-status',
		});
		const answerEl = agentMsg.createDiv({ cls: 'anti-dian-answer-body' });

		liveStatusEl.createSpan({
			text: 'Thinking...',
			cls: 'anti-dian-status-text',
		});

		const actions: ActionItem[] = [];

		try {
			const activeCtx = this.contextService.getActiveContext();
			const result = await this.agent.run(
				text,
				activeCtx,
				this.history,
				(step: AgentStepEvent) => {
					this.handleAgentStep(
						step,
						actions,
						actionsContainer,
						liveStatusEl,
					);
				},
			);

			this.history = result.updatedHistory;
			liveStatusEl.remove();

			await MarkdownRenderer.render(
				this.app,
				result.answer,
				answerEl,
				activeCtx.activeFile ?? '',
				this,
			);

			if (result.contextUsed && result.contextUsed.length > 0) {
				this.renderContextUsed(agentMsg, result.contextUsed);
			}

			if (result.changeSet && result.changeSet.operations.length > 0) {
				await this.renderChangeSet(agentMsg, result.changeSet);
			}
		} catch (err) {
			liveStatusEl.remove();
			answerEl.createEl('p', {
				text: `Error: ${err instanceof Error ? err.message : String(err)}`,
				cls: 'anti-dian-error-text',
			});
		} finally {
			this.isRunning = false;
			if (this.sendButtonEl) {
				this.sendButtonEl.disabled = false;
			}
			this.scrollToBottom();
		}
	}

	private handleAgentStep(
		step: AgentStepEvent,
		actions: ActionItem[],
		actionsContainer: HTMLElement,
		liveStatusEl: HTMLElement,
	): void {
		if (step.type === 'thinking') {
			liveStatusEl.empty();
			liveStatusEl.createSpan({
				text: 'Thinking...',
				cls: 'anti-dian-status-text',
			});
		} else if (step.type === 'tool_start') {
			const action: ActionItem = {
				id: `act_${Date.now()}_${actions.length}`,
				name: step.toolName,
				args: step.toolArgs,
				status: 'running',
			};
			actions.push(action);

			liveStatusEl.empty();
			liveStatusEl.createSpan({
				text: `Running ${step.toolName}...`,
				cls: 'anti-dian-status-text',
			});

			this.renderActions(actionsContainer, actions);
		} else if (step.type === 'tool_end') {
			const current = actions.find(
				(a) => a.name === step.toolName && a.status === 'running',
			);
			if (current) {
				current.output = step.toolOutput;
				current.status = 'done';
			}

			liveStatusEl.empty();
			liveStatusEl.createSpan({
				text: `Synthesizing...`,
				cls: 'anti-dian-status-text',
			});

			this.renderActions(actionsContainer, actions);
		}
		this.scrollToBottom();
	}

	private renderActions(
		container: HTMLElement,
		actions: ActionItem[],
	): void {
		container.empty();
		if (actions.length === 0) return;

		const details = container.createEl('details', {
			cls: 'anti-dian-actions-details',
		});
		details.open = true;

		const summary = details.createEl('summary', {
			cls: 'anti-dian-actions-summary',
		});
		summary.createSpan({
			text: `🛠️ Actions (${actions.length} ${actions.length === 1 ? 'tool call' : 'tool calls'})`,
			cls: 'anti-dian-actions-summary-title',
		});

		const list = details.createDiv({ cls: 'anti-dian-actions-list' });

		for (const act of actions) {
			const item = list.createDiv({ cls: 'anti-dian-action-item' });

			const header = item.createDiv({ cls: 'anti-dian-action-header' });
			const toolIcon = this.getToolIcon(act.name);
			header.createSpan({
				text: `${toolIcon} ${act.name}`,
				cls: 'anti-dian-action-name',
			});

			const argSummary = this.formatArgSummary(act.args);
			if (argSummary) {
				header.createSpan({
					text: argSummary,
					cls: 'anti-dian-action-args-summary',
				});
			}

			const statusBadge = header.createSpan({
				cls: `anti-dian-action-status anti-dian-status-${act.status}`,
			});
			statusBadge.setText(
				act.status === 'running'
					? 'running...'
					: act.status === 'done'
						? 'done ✓'
						: 'error',
			);

			if (act.output !== undefined) {
				const outputBox = item.createEl('details', {
					cls: 'anti-dian-action-output-details',
				});
				const outSummary = outputBox.createEl('summary', {
					text: this.formatOutputSummary(act.output),
					cls: 'anti-dian-action-out-summary',
				});
				outSummary.addClass('text-muted');

				const pre = outputBox.createEl('pre', {
					cls: 'anti-dian-action-raw-output',
				});
				pre.setText(
					typeof act.output === 'string'
						? act.output
						: JSON.stringify(act.output, null, 2),
				);
			}
		}
	}

	private getToolIcon(name: string): string {
		switch (name) {
			case 'search_notes':
				return '🔍';
			case 'read_note':
				return '📖';
			case 'create_note':
				return '📝';
			case 'patch_note':
				return '✏️';
			default:
				return '⚙️';
		}
	}

	private formatArgSummary(args: Record<string, unknown>): string {
		if (typeof args.query === 'string') {
			return `"${args.query}"`;
		}
		if (typeof args.path === 'string') {
			const note = args.path.replace(/\.md$/, '').split('/').pop();
			const h =
				typeof args.heading === 'string' ? ` > #${args.heading}` : '';
			return `[[${note}]]${h}`;
		}
		return '';
	}

	private formatOutputSummary(output: unknown): string {
		if (Array.isArray(output)) {
			return `Result: ${output.length} items`;
		}
		if (typeof output === 'object' && output !== null) {
			const rec = output as Record<string, unknown>;
			if (typeof rec.content === 'string') {
				return `Result: ${rec.content.length} characters`;
			}
			if (rec.staged) {
				return `Result: staged for review`;
			}
		}
		return 'Result preview';
	}

	private renderContextUsed(
		parent: HTMLElement,
		refs: ContextReference[],
	): void {
		if (!refs || refs.length === 0) {
			return;
		}

		const container = parent.createDiv({
			cls: 'anti-dian-context-used',
		});
		container.createDiv({
			text: 'Context used',
			cls: 'anti-dian-context-used-header',
		});

		const listEl = container.createDiv({
			cls: 'anti-dian-context-used-list',
		});

		const grouped = new Map<string, Set<string>>();
		for (const ref of refs) {
			if (!grouped.has(ref.path)) {
				grouped.set(ref.path, new Set());
			}
			if (ref.heading) {
				grouped.get(ref.path)?.add(ref.heading);
			}
		}

		for (const [filePath, headings] of grouped) {
			const itemEl = listEl.createDiv({
				cls: 'anti-dian-context-used-item',
			});

			const noteName = filePath.replace(/\.md$/, '').split('/').pop();
			const linkEl = itemEl.createEl('a', {
				text: `[[${noteName}]]`,
				cls: 'anti-dian-context-used-link internal-link',
			});
			linkEl.onclick = (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(filePath, '');
			};

			if (headings.size > 0) {
				const headingsList = itemEl.createDiv({
					cls: 'anti-dian-context-used-headings',
				});
				for (const heading of headings) {
					headingsList.createDiv({
						text: `# ${heading}`,
						cls: 'anti-dian-context-used-heading',
					});
				}
			}
		}
	}

	private async renderChangeSet(
		parent: HTMLElement,
		changeSet: ChangeSet,
	): Promise<void> {
		const card = parent.createDiv({ cls: 'anti-dian-changeset-card' });

		const header = card.createDiv({ cls: 'anti-dian-changeset-header' });
		header.createSpan({
			text: `📦 Staged ChangeSet (${changeSet.operations.length} ${changeSet.operations.length === 1 ? 'operation' : 'operations'})`,
			cls: 'anti-dian-changeset-title',
		});

		const badge = header.createSpan({
			text: 'Validating...',
			cls: 'anti-dian-changeset-badge',
		});

		const validation = this.validator
			? await this.validator.validate(changeSet)
			: { valid: true, errors: [] };

		if (validation.valid) {
			badge.setText('Validated ✓');
			badge.addClass('anti-dian-badge-valid');
		} else {
			badge.setText('Validation issues');
			badge.addClass('anti-dian-badge-invalid');
		}

		if (validation.errors.length > 0) {
			const errorBox = card.createDiv({
				cls: 'anti-dian-changeset-errors',
			});
			for (const err of validation.errors) {
				errorBox.createDiv({
					text: `⚠️ [${err.code}] ${err.message}`,
					cls: 'anti-dian-changeset-error-item',
				});
			}
		}

		const opsList = card.createDiv({ cls: 'anti-dian-changeset-ops' });
		for (const op of changeSet.operations) {
			const opItem = opsList.createDiv({
				cls: 'anti-dian-changeset-op-item',
			});
			const noteName = op.path.replace(/\.md$/, '').split('/').pop();

			if (op.type === 'create') {
				opItem.createSpan({
					text: '+ create',
					cls: 'anti-dian-op-tag anti-dian-op-tag-create',
				});
				opItem.createSpan({
					text: `[[${noteName}]]`,
					cls: 'anti-dian-op-path',
				});
			} else if (op.type === 'patch-section') {
				opItem.createSpan({
					text: '~ patch',
					cls: 'anti-dian-op-tag anti-dian-op-tag-patch',
				});
				opItem.createSpan({
					text: `[[${noteName}]] > #${op.heading}`,
					cls: 'anti-dian-op-path',
				});
			}
		}

		if (this.plugin.diffGenerator) {
			const diff = await this.plugin.diffGenerator.generate(changeSet);
			this.renderDiffPreview(card, diff);
		}
	}

	private renderDiffPreview(
		parent: HTMLElement,
		diff: {
			changeSetId: string;
			files: {
				path: string;
				heading?: string;
				additions: number;
				deletions: number;
				hunks: {
					header?: string;
					lines: {
						type: 'context' | 'added' | 'removed';
						content: string;
					}[];
				}[];
			}[];
			totalAdditions: number;
			totalDeletions: number;
		},
	): void {
		if (diff.files.length === 0) return;

		const details = parent.createEl('details', {
			cls: 'anti-dian-diff-container',
		});
		details.open = true;

		const summary = details.createEl('summary', {
			cls: 'anti-dian-diff-summary',
		});
		summary.createSpan({
			text: `Unified Diff (+${diff.totalAdditions} -${diff.totalDeletions})`,
			cls: 'anti-dian-diff-summary-title',
		});

		const filesList = details.createDiv({ cls: 'anti-dian-diff-files' });

		for (const file of diff.files) {
			const fileCard = filesList.createDiv({
				cls: 'anti-dian-diff-file-card',
			});

			const fileHeader = fileCard.createDiv({
				cls: 'anti-dian-diff-file-header',
			});
			const noteName = file.path.replace(/\.md$/, '').split('/').pop();
			const fileTitle = file.heading
				? `[[${noteName}]] > #${file.heading}`
				: `[[${noteName}]]`;

			fileHeader.createSpan({
				text: fileTitle,
				cls: 'anti-dian-diff-file-title',
			});

			const countsSpan = fileHeader.createSpan({
				cls: 'anti-dian-diff-counts',
			});
			if (file.additions > 0) {
				countsSpan.createSpan({
					text: `+${file.additions}`,
					cls: 'anti-dian-diff-count-add',
				});
			}
			if (file.deletions > 0) {
				countsSpan.createSpan({
					text: `-${file.deletions}`,
					cls: 'anti-dian-diff-count-del',
				});
			}

			const codeBlock = fileCard.createDiv({
				cls: 'anti-dian-diff-code-block',
			});

			for (const hunk of file.hunks) {
				if (hunk.header) {
					codeBlock.createDiv({
						text: hunk.header,
						cls: 'anti-dian-diff-hunk-header',
					});
				}

				for (const line of hunk.lines) {
					const lineEl = codeBlock.createDiv({
						cls: `anti-dian-diff-line anti-dian-diff-line-${line.type}`,
					});
					const prefix =
						line.type === 'added'
							? '+ '
							: line.type === 'removed'
								? '- '
								: '  ';
					lineEl.createSpan({
						text: `${prefix}${line.content}`,
						cls: 'anti-dian-diff-line-content',
					});
				}
			}
		}
	}

	private getLogoUrl(): string {
		const dir =
			this.plugin.manifest.dir ??
			`.obsidian/plugins/${this.plugin.manifest.id}`;
		return this.app.vault.adapter.getResourcePath(`${dir}/assets/logo.png`);
	}

	private scrollToBottom(): void {
		if (this.messagesEl) {
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		}
	}
}
