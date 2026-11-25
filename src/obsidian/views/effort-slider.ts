import type { ModelSelect } from '../../core/models/antigravity-acp';

/**
 * Bar with one stop per thinking level, made to sit inside a native `Menu` item.
 * A transparent range input on top handles dragging, clicking and accessibility.
 */
export class EffortSlider {
	readonly el = createDiv({ cls: 'anti-dian-effort' });
	private select: ModelSelect | undefined;
	private railEl: HTMLElement;
	private input: HTMLInputElement;
	/** Stops by level, so that a level shared by two models keeps its stop. */
	private stops = new Map<string, HTMLElement>();

	constructor(
		select: ModelSelect | undefined,
		private onSelect: (value: string) => void,
	) {
		// The menu cancels mousedown (no dragging) and closes on a click on its items.
		for (const type of ['mousedown', 'click']) {
			this.el.addEventListener(type, (evt) => evt.stopPropagation());
		}

		// Clipped while `el` animates open or shut (see styles.css).
		const content = this.el.createDiv({ cls: 'anti-dian-effort-content' });
		content.createDiv({ cls: 'anti-dian-effort-heading', text: 'Effort' });
		const bar = content.createDiv({ cls: 'anti-dian-effort-bar' });
		this.railEl = bar.createDiv({ cls: 'anti-dian-effort-rail' });
		this.railEl.createDiv({ cls: 'anti-dian-effort-track' });
		this.railEl.createDiv({ cls: 'anti-dian-effort-thumb' });
		this.input = bar.createEl('input', {
			cls: 'anti-dian-effort-input',
			attr: { type: 'range', min: 0, step: 1 },
		});
		this.input.addEventListener('input', () => this.render());
		this.input.addEventListener('change', () => this.commit());
		// Part of the section, so that it collapses with it.
		content.createDiv({ cls: 'anti-dian-menu-divider' });

		this.setSelect(select);
	}

	/** Shows other levels, or a level changed elsewhere; leaves a bar being dragged alone. */
	update(select: ModelSelect | undefined): void {
		if (select === this.select) return;
		if (select && this.hasOptions(select) && this.input.matches(':active')) {
			this.select = select;
			return;
		}
		this.setSelect(select);
	}

	private hasOptions(select: ModelSelect): boolean {
		const values = (s?: ModelSelect) => s?.options.map((o) => o.value).join('\n');
		return values(select) === values(this.select);
	}

	/** Moves by `delta` stops and reports the new value. */
	step(delta: number): void {
		if (!this.select) return;
		const before = this.input.valueAsNumber;
		// The range clamps the value to its limits.
		this.input.valueAsNumber = before + delta;
		if (this.input.valueAsNumber === before) return;
		this.render();
		this.commit();
	}

	private setSelect(select: ModelSelect | undefined): void {
		const wasCollapsed = !this.select;
		this.select = select;
		this.el.toggleClass('is-collapsed', !select);
		this.el.inert = !select;
		// The last levels stay visible while the section collapses.
		if (!select) return;

		const { options } = select;
		this.input.max = `${options.length - 1}`;
		this.input.valueAsNumber = options.findIndex((o) => o.value === select.current);
		// Nothing to see yet: start with the new layout instead of moving to it.
		const instant = wasCollapsed && this.el.offsetHeight === 0;
		this.el.toggleClass('is-instant', instant);
		this.syncStops(select, instant);
		this.render();
		if (instant) {
			// Apply the layout before transitions are back.
			void this.el.offsetWidth;
			this.el.removeClass('is-instant');
		}
	}

	/** Shared levels move to their new place; the others fade in or out. */
	private syncStops({ options }: ModelSelect, instant: boolean): void {
		const reduceMotion = this.el.win.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const animate = !instant && !reduceMotion;
		for (const [value, stop] of this.stops) {
			if (options.some((o) => o.value === value)) continue;
			this.stops.delete(value);
			if (!animate) {
				stop.remove();
				continue;
			}
			// Quick: the next stop may be moving to this place.
			stop.animate([{ opacity: 1 }, { opacity: 0 }], {
				duration: 100,
				fill: 'forwards',
			}).onfinish = () => stop.remove();
		}
		options.forEach((option, i) => {
			let stop = this.stops.get(option.value);
			if (!stop) {
				stop = this.railEl.createDiv({ cls: 'anti-dian-effort-stop' });
				this.stops.set(option.value, stop);
				if (animate) {
					stop.animate([{ opacity: 0 }, { opacity: 1 }], {
						duration: 240,
						easing: 'ease-in',
					});
				}
			}
			stop.setText(option.name);
			stop.setCssProps({ '--anti-dian-effort-pos': `${this.position(i)}` });
		});
	}

	/** Where a stop is along the rail, from 0 to 1. */
	private position(index: number): number {
		const last = (this.select?.options.length ?? 0) - 1;
		return last > 0 ? index / last : 0.5;
	}

	private render(): void {
		const index = this.input.valueAsNumber;
		this.railEl.setCssProps({ '--anti-dian-effort-pos': `${this.position(index)}` });
		this.select?.options.forEach((option, i) => {
			const stop = this.stops.get(option.value);
			stop?.toggleClass('is-filled', i <= index);
			stop?.toggleClass('is-current', i === index);
		});
		const name = this.select?.options[index]?.name ?? '';
		this.input.setAttr('aria-valuetext', `Effort: ${name}`);
	}

	private commit(): void {
		const option = this.select?.options[this.input.valueAsNumber];
		if (option) this.onSelect(option.value);
	}
}
