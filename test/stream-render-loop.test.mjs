import './ts-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamRenderLoop } from '../src/obsidian/views/stream-render-loop.ts';

/** Manual clock: frames and render completions run only when we advance. */
function harness(renderFrames) {
	let now = 0;
	const timers = [];
	const at = (t, fn) => timers.push({ t, fn });
	const tick = () => {
		now++;
		for (const timer of timers.filter((x) => x.t <= now)) {
			timers.splice(timers.indexOf(timer), 1);
			timer.fn();
		}
	};
	let text = '';
	const shown = [];
	const loop = new StreamRenderLoop({
		getText: () => text,
		schedule: (fn) => at(now + 1, fn),
		// Each render takes `renderFrames` frames (slow, like MathJax).
		render: (t) => new Promise((resolve) => at(now + renderFrames, () => resolve(t))),
		show: (_result, t) => shown.push(t),
	});
	return {
		loop,
		shown,
		setText: (t) => (text = t),
		async run(frames) {
			for (let i = 0; i < frames; i++) {
				tick();
				await Promise.resolve();
				await Promise.resolve();
			}
		},
	};
}

test('slow renders still show progress while text keeps growing', async () => {
	const h = harness(5);
	const full = 'Máy tính lượng tử dài $2^n$ (với $n$ qubit) bằng các phép quay.';
	// Text grows by 2 chars every frame, much faster than a 5-frame render.
	for (let i = 2; i <= full.length; i += 2) {
		h.setText(full.slice(0, i));
		h.loop.request();
		await h.run(1);
	}
	h.setText(full);
	h.loop.request();
	await h.run(20);

	// Old behaviour showed nothing until the end; now intermediate states appear.
	assert.ok(h.shown.length >= 4, `expected several intermediate renders, got ${h.shown.length}`);
	assert.ok(h.shown.some((t) => t.includes('$2^n') && t.length < full.length));
	// Shown text only ever moves forward, and the final text is shown last.
	for (let i = 1; i < h.shown.length; i++) assert.ok(h.shown[i].length >= h.shown[i - 1].length);
	assert.equal(h.shown.at(-1), full);
});

test('reset drops an in-flight render from the previous answer', async () => {
	const h = harness(3);
	h.setText('Old answer');
	h.loop.request();
	await h.run(1); // render of "Old answer" is now in flight
	h.loop.reset();
	h.setText('New');
	h.loop.request();
	await h.run(10);
	assert.deepEqual(h.shown, ['New']);
});

const flushMicrotasks = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

test('a failed render does not stall the loop', async () => {
	let fail = true;
	const shown = [];
	let text = 'a';
	const loop = new StreamRenderLoop({
		getText: () => text,
		schedule: (fn) => queueMicrotask(fn),
		render: (t) => (fail ? ((fail = false), Promise.reject(new Error('x'))) : Promise.resolve(t)),
		show: (_r, t) => shown.push(t),
	});
	loop.request();
	await flushMicrotasks();
	text = 'ab';
	loop.request();
	await flushMicrotasks();
	assert.deepEqual(shown, ['ab']);
});
