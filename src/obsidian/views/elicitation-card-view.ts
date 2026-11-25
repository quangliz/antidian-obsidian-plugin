import { setIcon } from 'obsidian';
import type {
	ElicitationField,
	ElicitationRequest,
	ElicitationResponse,
} from '../../core/types/elicitation';
import {
	type ElicitationDraftMap,
	type ElicitationFieldDraft,
	buildElicitationResponse,
	isFieldAnswered,
} from '../../core/models/elicitation';

/**
 * Interactive question/poll card docked above the prompt bar when the agent
 * sends an ACP `elicitation/create` request (such as `ask_question`).
 */
export class ElicitationCardView {
	private slotEl: HTMLElement;
	private activeRequest: ElicitationRequest | null = null;
	private activeResolve: ((res: ElicitationResponse) => void) | null = null;
	private drafts: ElicitationDraftMap = {};
	private currentIndex = 0;

	private cardEl: HTMLElement | null = null;
	private tabButtons: HTMLButtonElement[] = [];
	private submitBtnEl: HTMLButtonElement | null = null;
	private statusEl: HTMLElement | null = null;
	private otherRowEl: HTMLButtonElement | null = null;
	private otherInputEl: HTMLInputElement | null = null;

	constructor(slotEl: HTMLElement) {
		this.slotEl = slotEl;
	}

	public isActive(): boolean {
		return this.activeRequest !== null;
	}

	public show(request: ElicitationRequest): Promise<ElicitationResponse> {
		if (this.activeResolve) {
			this.finish({ action: 'cancel' });
		}

		this.activeRequest = request;
		this.drafts = {};
		this.currentIndex = 0;

		for (const field of request.fields) {
			const initial: ElicitationFieldDraft = {};
			if (field.kind === 'text' && typeof field.defaultValue === 'string') {
				initial.textValue = field.defaultValue;
			} else if (
				field.kind === 'number' &&
				typeof field.defaultValue === 'number'
			) {
				initial.textValue = String(field.defaultValue);
			} else if (
				field.kind === 'boolean' &&
				typeof field.defaultValue === 'boolean'
			) {
				initial.booleanValue = field.defaultValue;
			}
			this.drafts[field.key] = initial;
		}

		return new Promise<ElicitationResponse>((resolve) => {
			this.activeResolve = resolve;
			this.render();
			this.cardEl?.focus();
		});
	}

	public cancel(): void {
		if (!this.activeResolve) return;
		this.finish({ action: 'cancel' });
	}

	private finish(response: ElicitationResponse): void {
		const resolve = this.activeResolve;
		this.activeResolve = null;
		this.activeRequest = null;
		this.drafts = {};
		this.currentIndex = 0;
		this.cardEl = null;
		this.tabButtons = [];
		this.submitBtnEl = null;
		this.statusEl = null;
		this.otherRowEl = null;
		this.otherInputEl = null;
		this.slotEl.empty();
		resolve?.(response);
	}

	private getDraft(key: string): ElicitationFieldDraft {
		let draft = this.drafts[key];
		if (!draft) {
			draft = {};
			this.drafts[key] = draft;
		}
		return draft;
	}

	private answeredCount(): number {
		if (!this.activeRequest) return 0;
		return this.activeRequest.fields.filter((f) =>
			isFieldAnswered(f, this.drafts[f.key]),
		).length;
	}

	private canSubmit(): boolean {
		if (!this.activeRequest) return false;
		const fields = this.activeRequest.fields;
		for (const field of fields) {
			if (field.required && !isFieldAnswered(field, this.drafts[field.key])) {
				return false;
			}
		}
		return this.answeredCount() > 0;
	}

	private submit(): void {
		if (!this.activeRequest || !this.canSubmit()) return;
		this.finish(buildElicitationResponse(this.activeRequest, this.drafts));
	}

	private decline(): void {
		this.finish({ action: 'decline' });
	}

	private goTo(index: number): void {
		if (!this.activeRequest) return;
		const max = this.activeRequest.fields.length - 1;
		const clamped = Math.max(0, Math.min(max, index));
		if (clamped === this.currentIndex) return;
		this.currentIndex = clamped;
		this.render();
		this.cardEl?.focus();
	}

	private render(): void {
		this.slotEl.empty();
		this.tabButtons = [];
		this.submitBtnEl = null;
		this.statusEl = null;
		this.otherRowEl = null;
		this.otherInputEl = null;

		const request = this.activeRequest;
		if (!request) return;
		const fields = request.fields;
		const field = fields[this.currentIndex] ?? fields[0];
		if (!field) return;

		const card = this.slotEl.createDiv({
			cls: 'antidian-question-card',
			attr: {
				role: 'region',
				'aria-label': request.message,
				tabindex: '-1',
			},
		});
		this.cardEl = card;
		card.addEventListener('keydown', (e) => this.handleKeydown(e, field));

		// Header
		const header = card.createDiv({ cls: 'antidian-question-header' });
		const titleGroup = header.createDiv({
			cls: 'antidian-question-header-left',
		});
		const iconEl = titleGroup.createSpan({ cls: 'antidian-question-icon' });
		setIcon(iconEl, 'help-circle');
		titleGroup.createSpan({
			cls: 'antidian-question-title',
			text:
				fields.length > 1
					? `Question ${this.currentIndex + 1} of ${fields.length}`
					: 'Question',
		});

		if (fields.length > 1) {
			const tabs = header.createDiv({ cls: 'antidian-question-tabs' });
			fields.forEach((f, idx) => {
				const answered = isFieldAnswered(f, this.drafts[f.key]);
				const tabBtn = tabs.createEl('button', {
					cls: 'antidian-question-tab',
					attr: {
						type: 'button',
						'aria-label': `Question ${idx + 1}: ${f.title}`,
						'aria-current': idx === this.currentIndex ? 'step' : 'false',
					},
				});
				tabBtn.toggleClass('is-active', idx === this.currentIndex);
				tabBtn.toggleClass('is-answered', answered);
				if (answered) {
					const checkEl = tabBtn.createSpan({
						cls: 'antidian-question-tab-check',
					});
					setIcon(checkEl, 'check');
				}
				tabBtn.createSpan({ text: String(idx + 1) });
				tabBtn.onclick = () => this.goTo(idx);
				this.tabButtons.push(tabBtn);
			});
		}

		// Body
		const body = card.createDiv({ cls: 'antidian-question-body' });
		body.createDiv({
			cls: 'antidian-question-prompt',
			text: field.title,
		});

		const hintText = this.getFieldHint(field);
		if (hintText) {
			body.createDiv({
				cls: 'antidian-question-hint',
				text: hintText,
			});
		}

		if (field.kind === 'single-select' || field.kind === 'multi-select') {
			this.renderChoiceField(body, field);
		} else if (field.kind === 'boolean') {
			this.renderBooleanField(body, field);
		} else {
			this.renderPrimitiveField(body, field);
		}

		// Footer
		const footer = card.createDiv({ cls: 'antidian-question-footer' });
		const leftActions = footer.createDiv({
			cls: 'antidian-question-footer-left',
		});
		const skipBtn = leftActions.createEl('button', {
			cls: 'antidian-question-btn is-ghost',
			text: 'Skip',
			attr: { type: 'button' },
		});
		skipBtn.onclick = () => this.decline();

		this.statusEl = leftActions.createSpan({
			cls: 'antidian-question-status',
		});

		const rightActions = footer.createDiv({
			cls: 'antidian-question-footer-right',
		});
		const isMultiQuestion = fields.length > 1;
		const isLast = this.currentIndex === fields.length - 1;

		if (isMultiQuestion && this.currentIndex > 0) {
			const backBtn = rightActions.createEl('button', {
				cls: 'antidian-question-btn',
				text: 'Back',
				attr: { type: 'button' },
			});
			backBtn.onclick = () => this.goTo(this.currentIndex - 1);
		}

		if (isMultiQuestion && !isLast) {
			const nextBtn = rightActions.createEl('button', {
				cls: 'antidian-question-btn mod-cta',
				text: 'Next',
				attr: { type: 'button' },
			});
			nextBtn.onclick = () => this.goTo(this.currentIndex + 1);
		} else {
			const submitBtn = rightActions.createEl('button', {
				cls: 'antidian-question-btn mod-cta',
				text: 'Submit',
				attr: { type: 'button' },
			});
			submitBtn.onclick = () => this.submit();
			this.submitBtnEl = submitBtn;
		}

		this.syncInteractiveState();
	}

	private getFieldHint(field: ElicitationField): string | undefined {
		if (field.kind === 'multi-select') {
			return field.description
				? `${field.description} · Select all that apply`
				: 'Select all that apply';
		}
		if (field.kind === 'single-select') {
			return field.description
				? `${field.description} · Select one`
				: 'Select one';
		}
		return field.description;
	}

	private renderChoiceField(
		parent: HTMLElement,
		field: ElicitationField,
	): void {
		const isMulti = field.kind === 'multi-select';
		const draft = this.getDraft(field.key);
		const selectedSet = new Set(draft.selectedValues ?? []);
		const options = field.options ?? [];

		const list = parent.createDiv({
			cls: 'antidian-question-options',
			attr: { role: isMulti ? 'group' : 'radiogroup' },
		});

		options.forEach((opt, idx) => {
			const isSelected = selectedSet.has(opt.value);
			const btn = list.createEl('button', {
				cls: 'antidian-question-option',
				attr: {
					type: 'button',
					role: isMulti ? 'checkbox' : 'radio',
					'aria-checked': String(isSelected),
				},
			});
			btn.toggleClass('is-selected', isSelected);

			btn.createSpan({
				cls: 'antidian-question-option-num',
				text: String(idx + 1),
			});

			const indicator = btn.createSpan({
				cls: `antidian-question-indicator ${isMulti ? 'is-checkbox' : 'is-radio'}`,
			});
			if (isMulti && isSelected) {
				setIcon(indicator, 'check');
			}

			const labelWrap = btn.createSpan({
				cls: 'antidian-question-option-label',
			});
			labelWrap.createSpan({ text: opt.label });
			if (opt.recommended) {
				labelWrap.createSpan({
					cls: 'antidian-question-recommended',
					text: 'Recommended',
				});
			}

			btn.onclick = () => {
				this.toggleChoice(field, opt.value);
			};
		});

		if (field.otherKey) {
			const otherIndex = options.length + 1;
			const otherSelected = isMulti
				? Boolean(draft.otherSelected || (draft.otherText ?? '').trim())
				: Boolean(draft.otherSelected);

			const otherWrap = list.createDiv({
				cls: 'antidian-question-other-wrap',
			});
			otherWrap.toggleClass('is-selected', otherSelected);

			const otherBtn = otherWrap.createEl('button', {
				cls: 'antidian-question-option is-other',
				attr: {
					type: 'button',
					role: isMulti ? 'checkbox' : 'radio',
					'aria-checked': String(otherSelected),
				},
			});
			otherBtn.toggleClass('is-selected', otherSelected);
			this.otherRowEl = otherBtn;

			otherBtn.createSpan({
				cls: 'antidian-question-option-num',
				text: String(otherIndex),
			});

			const indicator = otherBtn.createSpan({
				cls: `antidian-question-indicator ${isMulti ? 'is-checkbox' : 'is-radio'}`,
			});
			if (isMulti && otherSelected) {
				setIcon(indicator, 'check');
			}

			otherBtn.createSpan({
				cls: 'antidian-question-option-label',
				text: field.otherLabel ?? 'Other',
			});

			const input = otherWrap.createEl('input', {
				cls: 'antidian-question-other-input',
				attr: {
					type: 'text',
					placeholder: 'Type your own answer...',
					'aria-label': field.otherDescription ?? 'Other answer',
				},
			});
			input.value = draft.otherText ?? '';
			this.otherInputEl = input;
			if (!otherSelected && !input.value) {
				input.addClass('antidian-hidden');
			}

			otherBtn.onclick = () => {
				if (isMulti) {
					const next = !(draft.otherSelected || Boolean((draft.otherText ?? '').trim()));
					draft.otherSelected = next;
					if (!next) {
						draft.otherText = '';
					}
					this.render();
					if (next) this.otherInputEl?.focus();
				} else {
					draft.selectedValues = [];
					draft.otherSelected = true;
					this.render();
					this.otherInputEl?.focus();
				}
			};

			input.addEventListener('input', () => {
				const text = input.value;
				draft.otherText = text;
				if (!isMulti) {
					if (text.trim()) {
						draft.selectedValues = [];
						draft.otherSelected = true;
					}
				} else {
					draft.otherSelected = text.trim().length > 0 || draft.otherSelected;
				}
				this.syncInteractiveState();
			});

			input.addEventListener('keydown', (e) => {
				if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					input.blur();
					this.cardEl?.focus();
					return;
				}
				if (e.key === 'Enter' && !e.isComposing) {
					e.preventDefault();
					e.stopPropagation();
					this.handleEnterAdvance();
				}
			});
		}
	}

	private renderBooleanField(
		parent: HTMLElement,
		field: ElicitationField,
	): void {
		const draft = this.getDraft(field.key);
		const list = parent.createDiv({
			cls: 'antidian-question-options',
			attr: { role: 'radiogroup' },
		});

		const choices: { label: string; value: boolean }[] = [
			{ label: 'Yes', value: true },
			{ label: 'No', value: false },
		];
		choices.forEach((choice, idx) => {
			const isSelected = draft.booleanValue === choice.value;
			const btn = list.createEl('button', {
				cls: 'antidian-question-option',
				attr: {
					type: 'button',
					role: 'radio',
					'aria-checked': String(isSelected),
				},
			});
			btn.toggleClass('is-selected', isSelected);
			btn.createSpan({
				cls: 'antidian-question-option-num',
				text: String(idx + 1),
			});
			btn.createSpan({
				cls: 'antidian-question-indicator is-radio',
			});
			btn.createSpan({
				cls: 'antidian-question-option-label',
				text: choice.label,
			});
			btn.onclick = () => {
				draft.booleanValue = choice.value;
				this.render();
			};
		});
	}

	private renderPrimitiveField(
		parent: HTMLElement,
		field: ElicitationField,
	): void {
		const draft = this.getDraft(field.key);
		const input = parent.createEl('input', {
			cls: 'antidian-question-text-input',
			attr: {
				type: field.kind === 'number' ? 'number' : 'text',
				placeholder:
					field.kind === 'number' ? 'Enter a number...' : 'Type your answer...',
				'aria-label': field.title,
			},
		});
		input.value = draft.textValue ?? '';
		input.addEventListener('input', () => {
			draft.textValue = input.value;
			this.syncInteractiveState();
		});
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				input.blur();
				this.cardEl?.focus();
				return;
			}
			if (e.key === 'Enter' && !e.isComposing) {
				e.preventDefault();
				e.stopPropagation();
				this.handleEnterAdvance();
			}
		});
		window.requestAnimationFrame(() => input.focus());
	}

	private toggleChoice(field: ElicitationField, value: string): void {
		const draft = this.getDraft(field.key);
		if (field.kind === 'multi-select') {
			const current = new Set(draft.selectedValues ?? []);
			if (current.has(value)) current.delete(value);
			else current.add(value);
			draft.selectedValues = Array.from(current);
		} else {
			draft.selectedValues = [value];
			draft.otherSelected = false;
			draft.otherText = '';
		}
		this.render();
		this.cardEl?.focus();
	}

	/** Updates submit button, status label, and stepper checkmarks without re-rendering inputs. */
	private syncInteractiveState(): void {
		const request = this.activeRequest;
		if (!request) return;

		if (this.submitBtnEl) {
			this.submitBtnEl.disabled = !this.canSubmit();
		}

		if (this.statusEl) {
			if (request.fields.length > 1) {
				this.statusEl.setText(
					`${this.answeredCount()} of ${request.fields.length} answered`,
				);
			} else {
				this.statusEl.setText('');
			}
		}

		request.fields.forEach((field, idx) => {
			const tab = this.tabButtons[idx];
			if (!tab) return;
			const answered = isFieldAnswered(field, this.drafts[field.key]);
			const wasAnswered = tab.hasClass('is-answered');
			if (answered !== wasAnswered) {
				tab.toggleClass('is-answered', answered);
				tab.empty();
				if (answered) {
					const checkEl = tab.createSpan({
						cls: 'antidian-question-tab-check',
					});
					setIcon(checkEl, 'check');
				}
				tab.createSpan({ text: String(idx + 1) });
			}
		});
	}

	private handleEnterAdvance(): void {
		const request = this.activeRequest;
		if (!request) return;
		if (this.currentIndex < request.fields.length - 1) {
			this.goTo(this.currentIndex + 1);
		} else if (this.canSubmit()) {
			this.submit();
		}
	}

	private handleKeydown(e: KeyboardEvent, field: ElicitationField): void {
		const target = e.target as HTMLElement | null;
		const inTextInput =
			target instanceof HTMLInputElement ||
			target instanceof HTMLTextAreaElement;
		if (inTextInput) return;

		const request = this.activeRequest;
		if (!request) return;

		if (request.fields.length > 1 && e.key === 'ArrowLeft') {
			e.preventDefault();
			this.goTo(this.currentIndex - 1);
			return;
		}
		if (request.fields.length > 1 && e.key === 'ArrowRight') {
			e.preventDefault();
			this.goTo(this.currentIndex + 1);
			return;
		}

		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			const optionBtns = Array.from(
				this.cardEl?.querySelectorAll<HTMLButtonElement>(
					'.antidian-question-option',
				) ?? [],
			);
			if (optionBtns.length === 0) return;
			e.preventDefault();
			const activeIdx = optionBtns.indexOf(
				this.slotEl.doc.activeElement as HTMLButtonElement,
			);
			const delta = e.key === 'ArrowDown' ? 1 : -1;
			const nextIdx =
				activeIdx === -1
					? delta > 0
						? 0
						: optionBtns.length - 1
					: (activeIdx + delta + optionBtns.length) % optionBtns.length;
			optionBtns[nextIdx]?.focus();
			return;
		}

		// Number shortcuts 1-9 for options + Other
		if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
			const idx = Number.parseInt(e.key, 10) - 1;
			if (field.kind === 'single-select' || field.kind === 'multi-select') {
				const options = field.options ?? [];
				const opt = options[idx];
				if (opt) {
					e.preventDefault();
					this.toggleChoice(field, opt.value);
					return;
				}
				if (field.otherKey && idx === options.length && this.otherRowEl) {
					e.preventDefault();
					this.otherRowEl.click();
					return;
				}
			} else if (field.kind === 'boolean' && (idx === 0 || idx === 1)) {
				e.preventDefault();
				const draft = this.getDraft(field.key);
				draft.booleanValue = idx === 0;
				this.render();
				this.cardEl?.focus();
				return;
			}
		}

		if (e.key === 'Enter' && !e.isComposing) {
			// Let focused option/footer buttons handle their own click via Enter
			if (
				target instanceof HTMLButtonElement &&
				target.hasClass('antidian-question-btn')
			) {
				return;
			}
			e.preventDefault();
			this.handleEnterAdvance();
		}
	}
}
