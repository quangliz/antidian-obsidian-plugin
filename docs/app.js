/*
 * Every state of the page is written in index.html. Elements carry
 * data-show="state state"; a container's data-view decides which are visible.
 */
function setView(root, view) {
	root.dataset.view = view;
	root.querySelectorAll('[data-show]').forEach((el) => {
		el.hidden = !el.dataset.show.split(' ').includes(view);
	});
}

/** Buttons disappear when their state ends, so move focus to the next one. */
function changeView(root, view, trigger) {
	const scope = trigger.closest('.diff-bar, .approval')?.parentElement ?? root;
	setView(root, view);
	if (trigger.offsetParent !== null) return;
	const next = [
		...scope.querySelectorAll('button'),
		...root.querySelectorAll('.approval button'),
		...root.querySelectorAll('button'),
	].find(
		(b) => b.offsetParent !== null,
	);
	next?.focus({ preventScroll: true });
}

/* ── Hero edit ───────────────────────────────────────────────────────────── */

const hero = document.getElementById('hero');
hero.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-set]');
	if (btn) changeView(hero, btn.dataset.set, btn);
});

/* ── Permission mode demo ────────────────────────────────────────────────── */

const demo = document.getElementById('demo');
let mode = 'ask';
demo.addEventListener('click', (e) => {
	const btn = e.target.closest('button');
	if (!btn) return;
	if (btn.dataset.mode) {
		mode = btn.dataset.mode;
		press(demo.querySelectorAll('[data-mode]'), btn);
		setView(demo, mode);
	} else if (btn.dataset.set) {
		changeView(demo, btn.dataset.set, btn);
	} else if ('reset' in btn.dataset) {
		changeView(demo, mode, btn);
	}
});

function press(buttons, active) {
	buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === active)));
}

/* ── Outline: mark the section being read ────────────────────────────────── */

const links = [...document.querySelectorAll('.outline a')];
const sections = links.map((a) => document.querySelector(a.hash));
function markCurrent() {
	const line = window.innerHeight * 0.35;
	let current = -1;
	sections.forEach((s, i) => {
		if (s.getBoundingClientRect().top <= line) current = i;
	});
	// The last section may be too short to reach the line.
	if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
		current = sections.length - 1;
	}
	links.forEach((a, i) => {
		if (i === current) a.setAttribute('aria-current', 'true');
		else a.removeAttribute('aria-current');
	});
}
window.addEventListener('scroll', markCurrent, { passive: true });
window.addEventListener('resize', markCurrent);
markCurrent();
