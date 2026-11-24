export interface SkillSummary {
	name: string;
	description: string;
	path: string;
}

export interface SkillDocument extends SkillSummary {
	body: string;
}

export interface SkillService {
	listSkills(): Promise<SkillSummary[]>;
	loadSkill(name: string): Promise<SkillDocument | null>;
}
