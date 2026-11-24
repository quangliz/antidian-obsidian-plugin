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

/* ── Example skills ──────────────────────────────────────────────────────── */

const skillCode = document.getElementById('skill-code');
const skillPath = document.getElementById('skill-path');
const SKILLS = {
	daily: skillCode.textContent,
	meeting: `---
name: meeting-notes
description: Turn raw meeting notes into decisions, owners and next steps.
---

# Meeting notes

1. Read the active note and any project note it links to.
2. Pull out decisions, open questions and who owns what.
3. Link people and projects that already have a note.
4. Replace only the "Summary" section.`,
	books: `---
name: book-log
description: Add a finished book to the reading log with consistent properties.
---

# Book log

1. Read two existing book notes to match their properties.
2. Create the new note in the same folder.
3. Set author, finished and rating. Leave unknown values empty.
4. Link the book from the reading list.`,
};
const SKILL_NAMES = { daily: 'daily-review', meeting: 'meeting-notes', books: 'book-log' };

document.querySelectorAll('[data-skill]').forEach((btn, _, all) => {
	btn.addEventListener('click', () => {
		const key = btn.dataset.skill;
		press(all, btn);
		skillCode.textContent = SKILLS[key];
		skillPath.textContent = `.anti-dian/skills/${SKILL_NAMES[key]}.md`;
	});
});

/* ── Copy ────────────────────────────────────────────────────────────────── */

document.querySelectorAll('[data-copy]').forEach((btn) => {
	btn.addEventListener('click', async () => {
		const source = document.querySelector(btn.dataset.copy);
		try {
			await navigator.clipboard.writeText(source.textContent);
			btn.textContent = 'Copied';
		} catch {
			// Clipboard blocked: select the text so the user can copy it by hand.
			window.getSelection()?.selectAllChildren(source);
			btn.textContent = 'Selected';
		}
		window.setTimeout(() => (btn.textContent = 'Copy'), 1600);
	});
});

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
