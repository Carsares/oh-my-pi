export type SkillSourceLevel = "user" | "project";
export type SkillDiscoveryKind = "standard" | "custom" | "managed" | "plugin";
export type SkillCatalogStatus = "available" | "missing" | "invalid";

export interface SkillSourceRef {
	providerId: string;
	level: SkillSourceLevel;
	sourceRoot: string;
	discoveredPath: string;
	projectRoot?: string;
	discoveryKind: SkillDiscoveryKind;
	providerPriority: number;
	projectDistance?: number;
}

/** A pre-name-deduplication discovery result whose canonicalPath is the realpath of SKILL.md. */
export interface SkillCatalogCandidate extends SkillSourceRef {
	canonicalPath: string;
	name?: string;
	description?: string;
	status: "available" | "invalid";
	parseError?: string;
}

export interface SkillCatalogEntry {
	skillId: string;
	canonicalPath: string;
	name?: string;
	description?: string;
	lastKnownName?: string;
	lastKnownDescription?: string;
	status: SkillCatalogStatus;
	parseError?: string;
	sources: SkillSourceRef[];
	firstSeenAt: string;
	lastSeenAt: string;
}

export interface SkillCatalogState {
	schemaVersion: 1;
	revision: number;
	entries: SkillCatalogEntry[];
}

export interface SuccessfulSkillRootScan {
	status: "success";
	providerId: string;
	sourceRoot: string;
	candidates: SkillCatalogCandidate[];
}

export interface FailedSkillRootScan {
	status: "failed";
	providerId: string;
	sourceRoot: string;
	error?: string;
}

export type SkillRootScanResult = SuccessfulSkillRootScan | FailedSkillRootScan;
