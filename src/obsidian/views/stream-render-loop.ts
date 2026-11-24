/**
 * Coalescing render loop for streamed answers (no Obsidian imports, so it is unit-testable).
 *
 * Text grows every frame, but a Markdown render can take longer than a frame
 * (MathJax for `$…$`, big tables, code highlighting). Discarding every render
 * that finished after the text moved on starves the view: nothing is shown
 * until the stream ends. Instead, keep one render in flight, always show the
 * result when it completes, then render again with the latest text if it changed.
 */
export interface StreamRenderLoopOptions<T> {
	/** Latest text to render. */
	getText: () => string;
	/** Renders text off-screen; resolves with something `show` can display. */
	render: (text: string) => Promise<T>;
	/** Puts a completed render on screen. */
	show: (result: T, text: string) => void;
	/** Defers work to the next frame (requestAnimationFrame in the view). */
	schedule: (fn: () => void) => void;
}

export class StreamRenderLoop<T> {
	private scheduled = false;
	private inFlight = false;
	private dirty = false;
	/** Bumped by `reset()`; renders from an older epoch are never shown. */
	private epoch = 0;
	private shownText: string | null = null;
	private options: StreamRenderLoopOptions<T>;

	constructor(options: StreamRenderLoopOptions<T>) {
		this.options = options;
	}

	/** Ask for the latest text to be rendered (cheap to call every frame). */
	request(): void {
		if (this.inFlight || this.scheduled) {
			this.dirty = true;
			return;
		}
		this.scheduled = true;
		this.options.schedule(() => this.run());
	}

	/** Forget pending work: a new answer started, or streaming ended. */
	reset(): void {
		this.epoch++;
		this.dirty = false;
		this.shownText = null;
	}

	private run(): void {
		this.scheduled = false;
		this.dirty = false;
		const epoch = this.epoch;
		const text = this.options.getText();
		if (text === this.shownText) return;
		this.inFlight = true;
		const finish = () => {
			this.inFlight = false;
			if (epoch !== this.epoch) {
				// Superseded by reset(); render the new epoch's text if it was requested.
				if (this.dirty) this.request();
				return;
			}
			if (this.dirty || this.options.getText() !== text) this.request();
		};
		this.options.render(text).then(
			(result) => {
				if (epoch === this.epoch) {
					this.shownText = text;
					this.options.show(result, text);
				}
				finish();
			},
			() => finish(),
		);
	}
}
