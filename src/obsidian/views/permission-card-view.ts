import { setIcon } from 'obsidian';
import type {
	ToolPermissionDecision,
	ToolPermissionRequest,
} from '../../core/types/permissions';

const MAX_ARGS_CHARS = 400;

interface PermissionChoice {
	decision: Exclude<ToolPermissionDecision, 'cancel'>;
	label: string;
	detail?: string;
}

/**
 * Card docked above the prompt bar that asks whether a tool call `agy` wants to
 * make may run (`session/request_permission` requests Antidian does not decide
 * itself). The client puts one request at a time.
 */
export class PermissionCardView {
	private slotEl: HTMLElement;
	private activeRequest: ToolPermissionRequest | null = null;
	private activeResolve: ((decision: ToolPermissionDecision) => void) | null = null;

	constructor(slotEl: HTMLElement) {
		this.slotEl = slotEl;
	}

	public show(request: ToolPermissionRequest): Promise<ToolPermissionDecision> {
		if (this.activeResolve) this.finish('cancel');
		this.activeRequest = request;
		return new Promise<ToolPermissionDecision>((resolve) => {
			this.activeResolve = resolve;
			this.render();
		});
	}

	public cancel(): void {
		if (this.activeResolve) this.finish('cancel');
	}

	private finish(decision: ToolPermissionDecision): void {
		const resolve = this.activeResolve;
		this.activeResolve = null;
		this.activeRequest = null;
		this.slotEl.empty();
		resolve?.(decision);
	}

	private render(): void {
		this.slotEl.empty();
		const request = this.activeRequest;
		if (!request) return;

		const card = this.slotEl.createDiv({
			cls: 'antidian-question-card antidian-permission-card',
			attr: {
				role: 'region',
				'aria-label': `Allow ${request.toolName}?`,
				tabindex: '-1',
			},
		});

		const header = card.createDiv({ cls: 'antidian-question-header' });
		const titleGroup = header.createDiv({ cls: 'antidian-question-header-left' });
		const iconEl = titleGroup.createSpan({ cls: 'antidian-question-icon' });
		setIcon(iconEl, 'shield-question');
		titleGroup.createSpan({
			cls: 'antidian-question-title',
			text: request.planMode ? 'Permission · Plan mode' : 'Permission',
		});

		const body = card.createDiv({ cls: 'antidian-question-body' });
		const prompt = body.createDiv({ cls: 'antidian-question-prompt' });
		prompt.appendText('Allow ');
		prompt.createEl('code', { text: request.toolName });
		prompt.appendText('?');

		const target = request.target ?? formatArgs(request.rawInput);
		if (target) {
			body.createDiv({ cls: 'antidian-permission-target', text: target });
		}
		body.createDiv({
			cls: 'antidian-question-hint',
			text: request.planMode
				? 'Plan mode is on, and this tool may change things outside the vault. Denying it ends the turn.'
				: 'Antidian cannot check what this tool does. Denying it ends the turn.',
		});

		const choices: PermissionChoice[] = [
			{ decision: 'allow_once', label: 'Allow once' },
			{
				decision: 'allow_session',
				label: 'Allow for this session',
				detail: request.sessionScope,
			},
			{ decision: 'deny', label: 'Deny' },
		];
		const list = body.createDiv({ cls: 'antidian-question-options' });
		const buttons = choices.map((choice, idx) => {
			const btn = list.createEl('button', {
				cls: 'antidian-question-option',
				attr: { type: 'button' },
			});
			btn.createSpan({ cls: 'antidian-question-option-num', text: String(idx + 1) });
			const labelWrap = btn.createSpan({ cls: 'antidian-question-option-label' });
			labelWrap.createSpan({ text: choice.label });
			if (choice.detail) {
				labelWrap.createSpan({ cls: 'antidian-permission-scope', text: choice.detail });
			}
			btn.onclick = () => this.finish(choice.decision);
			return btn;
		});

		card.addEventListener('keydown', (e) => {
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			const choice = /^[1-3]$/.test(e.key) ? choices[Number(e.key) - 1] : undefined;
			if (choice) {
				e.preventDefault();
				this.finish(choice.decision);
				return;
			}
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				const current = buttons.indexOf(this.slotEl.doc.activeElement as HTMLButtonElement);
				const delta = e.key === 'ArrowDown' ? 1 : -1;
				const next =
					current === -1
						? delta > 0
							? 0
							: buttons.length - 1
						: (current + delta + buttons.length) % buttons.length;
				buttons[next]?.focus();
			}
		});
		// The card, not a button: a stray Enter must not allow anything.
		card.focus();
	}
}

/** The tool arguments as short JSON, for a call with no path, URL, or MCP target. */
function formatArgs(rawInput: Record<string, unknown> | undefined): string | undefined {
	if (!rawInput) return undefined;
	const shown = Object.fromEntries(
		Object.entries(rawInput).filter(([key]) => key !== 'toolSummary'),
	);
	if (Object.keys(shown).length === 0) return undefined;
	let text: string;
	try {
		text = JSON.stringify(shown);
	} catch {
		return undefined;
	}
	return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}…` : text;
}
