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

export class ContextCompiler {
	private vaultService?: Pick<VaultService, 'getNoteOutline'>;
	private skillService?: SkillService;
	private lastActiveFile: string | undefined;
	private lastSelection: string | undefined;
	private skillsInjectedInSession = false;

	constructor(options: ContextCompilerOptions = {}) {
		this.vaultService = options.vaultService;
		this.skillService = options.skillService;
	}

	reset(): void {
		this.lastActiveFile = undefined;
		this.lastSelection = undefined;
		this.skillsInjectedInSession = false;
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
				}
			} catch {
				// Ignore skill discovery errors
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
		}

		this.lastActiveFile = activeFile;
		this.lastSelection = selection;

		const prefix = blocks.length > 0 ? `${blocks.join('\n\n')}\n\n` : '';
		return {
			prompt: `${prefix}${userMessage}`,
			contextRefs,
		};
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
