import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';

export const ANTI_DIAN_VIEW_TYPE = 'anti-dian-sidebar';

export class AntiDianSidebarView extends ItemView {
	private inputEl: HTMLTextAreaElement | null = null;
	private messagesEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
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
		this.renderBody(container);
		this.renderInputArea(container);
	}

	async onClose(): Promise<void> {
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
					this.inputEl.focus();
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

		const sendButton = controlsRow.createEl('button', {
			cls: 'anti-dian-send-button mod-cta',
			attr: { 'aria-label': 'Send message' },
		});
		setIcon(sendButton, 'send');

		this.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				this.handleSend();
			}
		});

		sendButton.onclick = () => {
			this.handleSend();
		};
	}

	private handleSend(): void {
		if (!this.inputEl || !this.messagesEl) {
			return;
		}

		const text = this.inputEl.value.trim();
		if (!text) {
			return;
		}

		// Remove empty state if present
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

		const agentMsg = this.messagesEl.createDiv({
			cls: 'anti-dian-message anti-dian-message-agent',
		});
		agentMsg.createEl('p', {
			text: 'Agent loop not connected yet. Vertical slice in progress.',
			cls: 'anti-dian-placeholder-reply',
		});

		this.inputEl.value = '';
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}
}
