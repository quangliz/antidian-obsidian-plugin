import type { ModelSelect } from '../../core/models/antigravity-acp';

/**
 * Bar with one stop per thinking level, made to sit inside a native `Menu` item.
 * A transparent range input on top handles dragging, clicking and accessibility.
 */
export class EffortSlider {
	readonly el = createDiv({ cls: 'anti-dian-effort' });
	private select: ModelSelect | undefined;
	private input: HTMLInputElement | null = null;
	private stops: HTMLElement[] = [];

	constructor(
		select: ModelSelect | undefined,
		private onSelect: (value: string) => void,
	) {
		// The menu cancels mousedown (no dragging) and closes on a click on its items.
		for (const type of ['mousedown', 'click']) {
			this.el.addEventListener(type, (evt) => evt.stopPropagation());
		}
		this.build(select);
	}

	/** Shows other levels, or a level changed elsewhere; leaves a bar being dragged alone. */
	update(select: ModelSelect | undefined): void {
		if (select === this.select) return;
		const { input } = this;
		if (!select || !input || !this.hasOptions(select)) {
			this.build(select);
			return;
		}
		this.select = select;
		if (input.matches(':active')) return;
		input.valueAsNumber = select.options.findIndex((o) => o.value === select.current);
		this.render();
	}

	private hasOptions(select: ModelSelect): boolean {
		const values = (s?: ModelSelect) => s?.options.map((o) => o.value).join('\n');
		return values(select) === values(this.select);
	}

	/** Moves by `delta` stops and reports the new value. */
	step(delta: number): void {
		if (!this.input) return;
		const before = this.input.valueAsNumber;
		// The range clamps the value to its limits.
		this.input.valueAsNumber = before + delta;
		if (this.input.valueAsNumber === before) return;
		this.render();
		this.commit();
	}

	private build(select: ModelSelect | undefined): void {
		this.select = select;
		this.input = null;
		this.el.empty();
		this.el.createDiv({ cls: 'anti-dian-effort-heading', text: 'Effort' });
		if (!select) {
			// Keeps the height, so the menu does not move under the pointer.
			this.el.createDiv({ cls: 'anti-dian-effort-none', text: 'Model default' });
			return;
		}

		const { options } = select;
		const bar = this.el.createDiv({ cls: 'anti-dian-effort-bar' });
		bar.createDiv({ cls: 'anti-dian-effort-track' });
		this.stops = options.map((option) =>
			bar.createDiv({ cls: 'anti-dian-effort-stop', text: option.name }),
		);
		bar.createDiv({ cls: 'anti-dian-effort-thumb' });
		const input = bar.createEl('input', {
			cls: 'anti-dian-effort-input',
			attr: { type: 'range', min: 0, max: options.length - 1, step: 1 },
		});
		input.valueAsNumber = options.findIndex((o) => o.value === select.current);
		input.addEventListener('input', () => this.render());
		input.addEventListener('change', () => this.commit());
		this.input = input;
		this.render();
	}

	private render(): void {
		const index = this.input?.valueAsNumber ?? 0;
		this.el.setCssProps({
			'--anti-dian-effort-count': `${this.stops.length}`,
			'--anti-dian-effort-index': `${index}`,
		});
		this.stops.forEach((stop, i) => {
			stop.toggleClass('is-filled', i <= index);
			stop.toggleClass('is-current', i === index);
		});
		const name = this.select?.options[index]?.name ?? '';
		this.input?.setAttr('aria-valuetext', `Effort: ${name}`);
	}

	private commit(): void {
		const option = this.select?.options[this.input?.valueAsNumber ?? -1];
		if (option) this.onSelect(option.value);
	}
}
