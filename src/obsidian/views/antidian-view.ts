import {
	ItemView,
	MarkdownRenderer,
	WorkspaceLeaf,
	setIcon,
} from 'obsidian';
import {
	ActiveContext,
	ContextReference,
	ContextService,
} from '../../core/types/context';
import { Agent, AgentStepEvent } from '../../core/agent';
import { Message } from '../../core/types/model';
import { ChangeSet } from '../../core/types/changes';
import { ChangeSetValidator } from '../../core/transactions';

export const ANTI_DIAN_VIEW_TYPE = 'anti-dian-sidebar';

export class AntiDianView extends ItemView {
	private contextService: ContextService;
	private agent: Agent;
	private validator?: ChangeSetValidator;
	private unsubscribeContext: (() => void) | null = null;
	private contextBoxEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendButtonEl: HTMLButtonElement | null = null;
	private messagesEl: HTMLElement | null = null;
	private history: Message[] = [];
	private isRunning = false;

	constructor(
		leaf: WorkspaceLeaf,
		contextService: ContextService,
		agent: Agent,
		validator?: ChangeSetValidator,
	) {
		super(leaf);
		this.contextService = contextService;
		this.agent = agent;
		this.validator = validator;
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

		const iconSpan = titleRow.createSpan({ cls: 'anti-dian-icon' });
		setIcon(iconSpan, 'bot');

		titleRow.createSpan({
			text: 'Anti-dian',
			cls: 'anti-dian-title',
		});
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

		const bigIcon = emptyState.createDiv({ cls: 'anti-dian-big-icon' });
		setIcon(bigIcon, 'bot');

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

		const stepsEl = agentMsg.createDiv({ cls: 'anti-dian-steps' });
		const answerEl = agentMsg.createDiv({ cls: 'anti-dian-answer-body' });

		const stepItem = stepsEl.createDiv({
			cls: 'anti-dian-step anti-dian-step-thinking',
		});
		stepItem.createSpan({ text: 'Thinking...' });

		try {
			const activeCtx = this.contextService.getActiveContext();
			const result = await this.agent.run(
				text,
				activeCtx,
				this.history,
				(step: AgentStepEvent) => {
					this.handleAgentStep(step, stepsEl);
				},
			);

			this.history = result.updatedHistory;
			stepsEl.empty();

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
			stepsEl.empty();
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
	}

	private handleAgentStep(step: AgentStepEvent, stepsEl: HTMLElement): void {
		if (step.type === 'thinking') {
			stepsEl.empty();
			const s = stepsEl.createDiv({
				cls: 'anti-dian-step anti-dian-step-thinking',
			});
			s.createSpan({ text: 'Thinking...' });
		} else if (step.type === 'tool_start') {
			stepsEl.empty();
			const s = stepsEl.createDiv({
				cls: 'anti-dian-step anti-dian-step-tool',
			});
			const query =
				typeof step.toolArgs.query === 'string'
					? step.toolArgs.query
					: typeof step.toolArgs.path === 'string'
						? step.toolArgs.path
						: '';
			s.createSpan({
				text: `Calling ${step.toolName}${query ? ` ("${query}")` : ''}...`,
			});
		} else if (step.type === 'tool_end') {
			stepsEl.empty();
			const s = stepsEl.createDiv({
				cls: 'anti-dian-step anti-dian-step-tool-done',
			});
			s.createSpan({ text: `Processing ${step.toolName} results...` });
		}
		this.scrollToBottom();
	}

	private scrollToBottom(): void {
		if (this.messagesEl) {
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		}
	}
}
