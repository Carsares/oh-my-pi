export type CollectionSnapshot = {
	collectionId: string;
	collectionName: string;
	sourceCollectionRevision?: number;
	skillIds: string[];
	capturedAt: string;
};

export type SessionSkillsProfile = {
	schemaVersion: 1;
	revision: number;
	baseCollection: CollectionSnapshot;
	additionalCollections: CollectionSnapshot[];
	addedSkillIds: string[];
	disabledSkillIds: string[];
	updatedAt: string;
};

export type CreateSessionSkillsProfileParams = {
	baseCollection: CollectionSnapshot;
	additionalCollections?: readonly CollectionSnapshot[];
	addedSkillIds?: readonly string[];
	disabledSkillIds?: readonly string[];
	updatedAt?: string;
};

export type SessionSkillsVersion = {
	activeLeafId: string | null;
	revision: number;
};

export type SessionSkillsMutationContext = {
	expectedActiveLeafId: string | null;
	expectedRevision: number;
};

export type SessionSkillsSyncInput = {
	baseCollection: CollectionSnapshot;
	additionalCollections: readonly CollectionSnapshot[];
};

export type SessionSkillsProfileMutation =
	| { type: "set-base-collection"; collection: CollectionSnapshot }
	| { type: "add-collection"; collection: CollectionSnapshot }
	| { type: "remove-collection"; collectionId: string }
	| { type: "add-skill"; skillId: string }
	| { type: "remove-skill"; skillId: string }
	| { type: "disable-skill"; skillId: string }
	| { type: "restore-skill"; skillId: string }
	| { type: "activate-skill"; skillId: string; conflictingSkillIds: readonly string[] }
	| { type: "sync"; snapshots: SessionSkillsSyncInput };

export type SessionSkillIdsDiff = {
	addedSkillIds: string[];
	removedSkillIds: string[];
};

export type ReducedSessionSkillsProfile = {
	changed: boolean;
	profile: SessionSkillsProfile;
	effectiveSkillIds: string[];
	diff: SessionSkillIdsDiff;
};

export type SessionSkillsState = {
	activeLeafId: string | null;
	profile: SessionSkillsProfile | undefined;
};

export type SessionSkillsMutationResult = {
	changed: boolean;
	entryId?: string;
	activeLeafId: string | null;
	profile: SessionSkillsProfile;
	effectiveSkillIds: string[];
	diff: SessionSkillIdsDiff;
};

export type SessionSkillsProfileErrorCode =
	| "invalid_sync_collections"
	| "profile_invalid"
	| "profile_not_found"
	| "stale_profile";

export class SessionSkillsProfileError extends Error {
	readonly code: SessionSkillsProfileErrorCode;

	constructor(code: SessionSkillsProfileErrorCode, message: string) {
		super(message);
		this.name = "SessionSkillsProfileError";
		this.code = code;
	}
}
