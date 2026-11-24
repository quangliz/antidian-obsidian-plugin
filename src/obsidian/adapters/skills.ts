import { App } from 'obsidian';
import {
	SkillDocument,
	SkillService,
	SkillSummary,
} from '../../core/types/skills';
import {
	DEFAULT_SKILLS_FOLDER,
	parseSkillMarkdown,
} from '../../core/skills';

export class ObsidianSkillAdapter implements SkillService {
	private app: App;
	private skillsFolder: string;

	constructor(app: App, skillsFolder = DEFAULT_SKILLS_FOLDER) {
		this.app = app;
		this.skillsFolder = skillsFolder.replace(/^\/+|\/+$/g, '');
	}

	async listSkills(): Promise<SkillSummary[]> {
		const docs = await this.readAllSkillDocs();
		return docs.map(({ name, description, path }) => ({
			name,
			description,
			path,
		}));
	}

	async loadSkill(name: string): Promise<SkillDocument | null> {
		const target = name.trim().toLowerCase();
		if (!target) return null;

		const docs = await this.readAllSkillDocs();
		return (
			docs.find((d) => d.name.toLowerCase() === target) ??
			docs.find((d) =>
				d.path.toLowerCase().endsWith(`/${target}.md`),
			) ??
			null
		);
	}

	private async readAllSkillDocs(): Promise<SkillDocument[]> {
		const adapter = this.app.vault.adapter;
		try {
			const exists = await adapter.exists(this.skillsFolder);
			if (!exists) return [];

			const listed = await adapter.list(this.skillsFolder);
			const docs: SkillDocument[] = [];

			// 1. Direct markdown files: .anti-dian/skills/<name>.md
			for (const filePath of listed.files) {
				if (!filePath.toLowerCase().endsWith('.md')) continue;
				const basename =
					filePath
						.split('/')
						.pop()
						?.replace(/\.md$/i, '') ?? 'skill';
				try {
					const raw = await adapter.read(filePath);
					docs.push(parseSkillMarkdown(raw, filePath, basename));
				} catch {
					// Skip unreadable skill file
				}
			}

			// 2. Subfolder skills: .anti-dian/skills/<name>/SKILL.md
			for (const folderPath of listed.folders) {
				const folderName = folderPath.split('/').pop() ?? 'skill';
				const skillFile = `${folderPath}/SKILL.md`;
				try {
					if (await adapter.exists(skillFile)) {
						const raw = await adapter.read(skillFile);
						docs.push(
							parseSkillMarkdown(raw, skillFile, folderName),
						);
					}
				} catch {
					// Skip unreadable skill file
				}
			}

			docs.sort((a, b) => a.name.localeCompare(b.name));
			return docs;
		} catch {
			return [];
		}
	}
}
