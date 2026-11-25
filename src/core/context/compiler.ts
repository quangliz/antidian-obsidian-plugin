import type { ActiveContext, ContextReference } from '../types/context';
import type { SkillService } from '../types/skills';
import type { NoteOutline, VaultService } from '../types/vault';
import type { HarnessPermissionMode } from '../tools';

export interface ContextCompilerOptions {
	vaultService?: Pick<VaultService, 'getNoteOutline'>;
	skillService?: SkillService;
}

export interface CompiledTurnPrompt {
	prompt: string;
	contextRefs: ContextReference[];
}

export interface ForkedTurn {
	userText: string;
	agentText: string;
}

const FORK_BLOCK_START = '[Forked Conversation Context:\n';
const FORK_BLOCK_END = '\n</forked-context>]';
const MAX_FORK_CONTEXT_CHARS = 24_000;

export class ContextCompiler {
	private vaultService?: Pick<VaultService, 'getNoteOutline'>;
	private skillService?: SkillService;
	private lastActiveFile: string | undefined;
	private lastSelection: string | undefined;
	private skillsInjectedInSession = false;
	private pendingForkTurns: ForkedTurn[] | null = null;

	constructor(options: ContextCompilerOptions = {}) {
		this.vaultService = options.vaultService;
		this.skillService = options.skillService;
	}

	reset(): void {
		this.lastActiveFile = undefined;
		this.lastSelection = undefined;
		this.skillsInjectedInSession = false;
		this.pendingForkTurns = null;
	}

	/**
	 * Prepares a brand-new session forked from an earlier conversation: the
	 * parent turns are injected once on the next prompt so the model continues
	 * seamlessly from the fork point.
	 */
	seedForkedHistory(turns: ForkedTurn[]): void {
		this.reset();
		const nonEmpty = turns.filter(
			(t) => t.userText.trim().length > 0 || t.agentText.trim().length > 0,
		);
		this.pendingForkTurns = nonEmpty.length > 0 ? nonEmpty : null;
	}

	/**
	 * Prepares for continuing a stored session: skills were already disclosed
	 * in it, but the active note is unknown, so it is re-sent on the next turn.
	 */
	resumeSession(): void {
		this.reset();
		this.skillsInjectedInSession = true;
	}

	async compile(
		userMessage: string,
		context?: ActiveContext,
		permissionMode: HarnessPermissionMode = 'ask',
	): Promise<CompiledTurnPrompt> {
		const blocks: string[] = [];
		const contextRefs: ContextReference[] = [];

		// 1. Inject available vault skills once per session (progressive disclosure)
		if (!this.skillsInjectedInSession && this.skillService) {
			this.skillsInjectedInSession = true;
			try {
				const skills = await this.skillService.listSkills();
				if (skills.length > 0) {
					const lines = skills.map(
						(s) => `- ${s.name}: ${s.description}`,
					);
					blocks.push(
						`[Available Vault Skills (call load_skill(name) when relevant):\n${lines.join('\n')}\n]`,
					);
				} else {
					blocks.push('[Vault Skills: none configured]');
				}
			} catch {
				// Ignore skill discovery errors
			}
		}

		// 1b. If this session was forked from a previous conversation, inject its prefix once.
		if (this.pendingForkTurns && this.pendingForkTurns.length > 0) {
			const turns = this.pendingForkTurns;
			this.pendingForkTurns = null;
			const formatted = this.formatForkedTurns(turns);
			if (formatted) {
				blocks.push(`${FORK_BLOCK_START}${formatted}${FORK_BLOCK_END}`);
			}
		}

		// 2. Mode notice for Plan (read-only) mode
		if (permissionMode === 'plan') {
			blocks.push(
				'[Mode: Plan (read-only). Do not call mutation tools; analyze and present your proposed edits in markdown.]',
			);
		}

		// 3. Deduplicated active note & selection context
		const activeFile = context?.activeFile;
		const selection = context?.selection;
		const fileChanged = activeFile !== this.lastActiveFile;
		const selectionChanged = selection !== this.lastSelection;

		if (activeFile && (fileChanged || selectionChanged)) {
			const noteName = activeFile
				.replace(/\.md$/, '')
				.split('/')
				.pop();
			let noteBlock = `[Current Active Note: [[${noteName}]] (path: ${activeFile})]`;

			if (fileChanged && this.vaultService?.getNoteOutline) {
				try {
					const outline =
						await this.vaultService.getNoteOutline(activeFile);
					if (outline) {
						noteBlock += this.formatOutlineHint(outline);
					}
				} catch {
					// Ignore outline fetch errors
				}
			}

			if (selection) {
				noteBlock += `\n[Selected Text in Editor:\n${selection}\n]`;
			}

			blocks.push(noteBlock);
			contextRefs.push({
				path: activeFile,
				reason: 'Active note',
			});
			if (selection) {
				contextRefs.push({
					path: activeFile,
					reason: 'Selection',
					snippet: selection.length > 200 ? `${selection.slice(0, 200)}…` : selection,
				});
			}
		}

		this.lastActiveFile = activeFile;
		this.lastSelection = selection;

		const prefix = blocks.length > 0 ? `${blocks.join('\n\n')}\n\n` : '';
		return {
			prompt: `${prefix}${userMessage}`,
			contextRefs,
		};
	}

	private formatForkedTurns(turns: ForkedTurn[]): string {
		const segments: string[] = [];
		let total = 0;
		for (let i = turns.length - 1; i >= 0; i--) {
			const t = turns[i]!;
			const parts: string[] = [];
			if (t.userText.trim()) parts.push(`User: ${t.userText.trim()}`);
			if (t.agentText.trim()) parts.push(`Assistant: ${t.agentText.trim()}`);
			if (parts.length === 0) continue;
			const block = parts.join('\n');
			if (total + block.length > MAX_FORK_CONTEXT_CHARS && segments.length > 0) {
				break;
			}
			segments.push(block);
			total += block.length + 2;
		}
		segments.reverse();
		return segments.join('\n\n').slice(-MAX_FORK_CONTEXT_CHARS);
	}

	private formatOutlineHint(outline: NoteOutline): string {
		const parts: string[] = [];
		if (outline.tags.length > 0) {
			parts.push(`tags: ${outline.tags.slice(0, 8).join(', ')}`);
		}
		if (outline.headings.length > 0) {
			const headingList = outline.headings
				.slice(0, 12)
				.map((h) => `${'#'.repeat(h.level)} ${h.heading}`)
				.join(' | ');
			parts.push(`headings: ${headingList}`);
		}
		if (outline.backlinks.length > 0) {
			parts.push(`backlinks: ${outline.backlinks.length}`);
		}
		if (parts.length === 0) return '';
		return `\n[Active Note Outline: ${parts.join('; ')}]`;
	}
}

/**
 * Removes the context blocks `ContextCompiler.compile` prepends, recovering the
 * text the user typed. Used to show replayed history from a stored session.
 * Blocks are only stripped from the start, so user text is never altered.
 */
export function stripCompiledContext(prompt: string): string {
	let rest = prompt;
	for (;;) {
		const end = compiledBlockEnd(rest);
		if (end === null) return rest;
		rest = rest.slice(end);
	}
}

/** Length of the leading context block plus its `\n\n` separator, or null. */
function compiledBlockEnd(text: string): number | null {
	const singleLine = [
		'[Vault Skills: none configured]',
		'[Mode: Plan (read-only).',
	];
	if (text.startsWith(FORK_BLOCK_START)) {
		return endAfter(text, `${FORK_BLOCK_END}\n\n`);
	}
	if (text.startsWith('[Available Vault Skills')) {
		return endAfter(text, '\n]\n\n');
	}
	if (singleLine.some((p) => text.startsWith(p))) {
		return endAfter(text, ']\n\n');
	}
	if (text.startsWith('[Current Active Note: ')) {
		// Optional outline line, then an optional multi-line selection block.
		const selection = text.indexOf('\n[Selected Text in Editor:\n');
		const firstBreak = text.indexOf('\n\n');
		if (selection !== -1 && (firstBreak === -1 || selection < firstBreak)) {
			return endAfter(text, '\n]\n\n', selection);
		}
		return endAfter(text, ']\n\n');
	}
	return null;
}

function endAfter(text: string, marker: string, from = 0): number | null {
	const i = text.indexOf(marker, from);
	if (i !== -1) return i + marker.length;
	// An image-only prompt has no typed text, and the CLI trims the trailing `\n\n`.
	return text.trimEnd().endsWith(marker.trimEnd()) ? text.length : null;
}

/**
 * Extracts the parent conversation turns from a `[Forked Conversation Context:]`
 * block injected into a forked session's first prompt, if present.
 */
export function extractForkedContext(prompt: string): ForkedTurn[] {
	const startIdx = prompt.indexOf(FORK_BLOCK_START);
	if (startIdx === -1) return [];
	const bodyStart = startIdx + FORK_BLOCK_START.length;
	const endIdx = prompt.indexOf(FORK_BLOCK_END, bodyStart);
	if (endIdx === -1) return [];

	const body = prompt.slice(bodyStart, endIdx);
	const turns: ForkedTurn[] = [];
	let current: ForkedTurn | null = null;
	let field: 'user' | 'agent' | null = null;

	const flush = () => {
		if (!current) return;
		current.userText = current.userText.trim();
		current.agentText = current.agentText.trim();
		if (current.userText || current.agentText) {
			turns.push(current);
		}
		current = null;
		field = null;
	};

	for (const line of body.split(/\r?\n/)) {
		if (line.startsWith('User: ')) {
			flush();
			current = { userText: line.slice('User: '.length), agentText: '' };
			field = 'user';
		} else if (line.startsWith('Assistant: ')) {
			if (!current) {
				current = { userText: '', agentText: '' };
			}
			current.agentText = line.slice('Assistant: '.length);
			field = 'agent';
		} else if (current && field === 'user') {
			current.userText += `\n${line}`;
		} else if (current && field === 'agent') {
			current.agentText += `\n${line}`;
		}
	}
	flush();
	return turns;
}
