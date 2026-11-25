import type { ModelSelect } from '../../core/models/antigravity-acp';

export interface EffortSlider {
	el: HTMLElement;
	/** Moves by `delta` stops and reports the new value. */
	step: (delta: number) => void;
}

/**
 * Bar with one stop per thinking level, made to sit inside a native `Menu` item.
 * A transparent range input on top handles dragging, clicking and accessibility.
 */
export function createEffortSlider(
	select: ModelSelect,
	onSelect: (value: string) => void,
): EffortSlider {
	const { options } = select;
	const el = createDiv({ cls: 'anti-dian-effort' });
	el.createDiv({ cls: 'anti-dian-effort-heading', text: 'Effort' });

	const bar = el.createDiv({ cls: 'anti-dian-effort-bar' });
	bar.createDiv({ cls: 'anti-dian-effort-track' });
	const stops = options.map((option) =>
		bar.createDiv({ cls: 'anti-dian-effort-stop', text: option.name }),
	);
	bar.createDiv({ cls: 'anti-dian-effort-thumb' });
	const input = bar.createEl('input', {
		cls: 'anti-dian-effort-input',
		attr: { type: 'range', min: 0, max: options.length - 1, step: 1 },
	});

	const render = (): void => {
		const index = input.valueAsNumber;
		bar.setCssProps({
			'--anti-dian-effort-count': `${options.length}`,
			'--anti-dian-effort-index': `${index}`,
		});
		stops.forEach((stop, i) => {
			stop.toggleClass('is-filled', i <= index);
			stop.toggleClass('is-current', i === index);
		});
		input.setAttr('aria-valuetext', `Effort: ${options[index]?.name ?? ''}`);
	};
	const commit = (): void => {
		const option = options[input.valueAsNumber];
		if (option) onSelect(option.value);
	};

	input.valueAsNumber = Math.max(
		0,
		options.findIndex((o) => o.value === select.current),
	);
	input.addEventListener('input', render);
	input.addEventListener('change', commit);
	// The menu cancels mousedown (no dragging) and closes on a click on its items.
	for (const type of ['mousedown', 'click']) {
		el.addEventListener(type, (evt) => evt.stopPropagation());
	}
	render();

	return {
		el,
		step: (delta) => {
			const before = input.valueAsNumber;
			input.valueAsNumber = Math.min(
				options.length - 1,
				Math.max(0, before + delta),
			);
			if (input.valueAsNumber === before) return;
			render();
			commit();
		},
	};
}
