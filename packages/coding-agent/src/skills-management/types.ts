import type { Skill } from "../extensibility/skills";
import type { SkillCatalogEntry, SkillCatalogState, SkillSourceRef } from "./catalog";
import type {
	CollectionMutationContext,
	CollectionMutationResult,
	CreateCollectionParams,
	LocalAllSkillCollection,
	SkillCollection,
	SkillCollectionsListResult,
	SkillCollectionsSnapshot,
	UpdateCollectionParams,
} from "./collections";
import type { SkillNameResolution } from "./resolver";
import type { SessionSkillsMutationContext, SessionSkillsProfile } from "./session";

export type SkillEligibility = "eligible" | "blocked" | "out_of_scope";
export type SkillRuntimeStatus = "active" | "shadowed" | "disabled" | "inactive";

export interface SkillCatalogEntryState extends SkillCatalogEntry {
	eligibility: SkillEligibility;
	effectiveSource?: SkillSourceRef;
	reasons: string[];
}

export interface SkillCatalogQuery {
	name?: string;
	providerId?: string;
	status?: SkillCatalogEntry["status"];
}

export interface SkillCatalogListResult {
	revision: number;
	entries: SkillCatalogEntryState[];
}

export interface SkillDiagnostic {
	skillId?: string;
	code: string;
	reason: string;
	relatedSkillIds?: string[];
}

export interface ResolvedSessionSkills {
	activeSkillIds: string[];
	resolutions: SkillNameResolution[];
	diagnostics: SkillDiagnostic[];
}

export interface SkillMemberState {
	skillId: string;
	included: boolean;
	availability: SkillCatalogEntry["status"];
	eligibility: SkillEligibility;
	runtimeStatus: SkillRuntimeStatus;
	reasons: string[];
	entry?: SkillCatalogEntry;
}

export interface SessionSkillsStateResult {
	activeLeafId: string | null;
	profile: SessionSkillsProfile;
	catalogRevision: number;
	collectionsRevision: number;
	resolved: ResolvedSessionSkills;
	memberStates: SkillMemberState[];
}

export interface SessionSkillsSyncPreview {
	profileRevision: number;
	collectionsRevision: number;
	catalogRevision: number;
	addedSkillIds: string[];
	removedSkillIds: string[];
	newConflictNames: string[];
	winnerChanges: Array<{ name: string; previousSkillId?: string; nextSkillId?: string }>;
}

export interface SessionSkillsSyncRevisions {
	expectedProfileRevision: number;
	expectedCollectionsRevision: number;
	expectedCatalogRevision: number;
}

export interface AppliedSessionSkills {
	profile: SessionSkillsProfile;
	resolved: ResolvedSessionSkills;
	activeSkills: Skill[];
}

export interface SkillManagementCollectionApi {
	listCollections(): Promise<SkillCollectionsListResult>;
	getCollection(
		collectionId: string,
	): Promise<{ state: SkillCollectionsSnapshot["state"]; collection: SkillCollection | LocalAllSkillCollection }>;
	createCollection(
		params: CreateCollectionParams,
		context: CollectionMutationContext,
	): Promise<CollectionMutationResult>;
	updateCollection(
		params: UpdateCollectionParams,
		context: CollectionMutationContext,
	): Promise<CollectionMutationResult>;
	deleteCollection(collectionId: string, context: CollectionMutationContext): Promise<CollectionMutationResult>;
	setDefaultCollection(collectionId: string, context: CollectionMutationContext): Promise<CollectionMutationResult>;
}

export interface SkillManagementSessionApi {
	getSessionSkills(): Promise<SessionSkillsStateResult>;
	setBaseCollection(collectionId: string, context: SessionSkillsMutationContext): Promise<SessionSkillsStateResult>;
	addCollection(collectionId: string, context: SessionSkillsMutationContext): Promise<SessionSkillsStateResult>;
	removeCollection(collectionId: string, context: SessionSkillsMutationContext): Promise<SessionSkillsStateResult>;
	addSessionSkill(skillId: string, context: SessionSkillsMutationContext): Promise<SessionSkillsStateResult>;
	disableSessionSkill(skillId: string, context: SessionSkillsMutationContext): Promise<SessionSkillsStateResult>;
	restoreSessionSkill(skillId: string, context: SessionSkillsMutationContext): Promise<SessionSkillsStateResult>;
	activateSessionSkill(skillId: string, context: SessionSkillsMutationContext): Promise<SessionSkillsStateResult>;
	previewSessionSync(): Promise<SessionSkillsSyncPreview>;
	syncSessionSkills(
		revisions: SessionSkillsSyncRevisions,
		context: SessionSkillsMutationContext,
	): Promise<SessionSkillsStateResult>;
	refreshSessionSkills(): Promise<SessionSkillsStateResult>;
}

export type SkillManagementState = {
	catalog: SkillCatalogState;
	collections: SkillCollectionsSnapshot["state"];
};
