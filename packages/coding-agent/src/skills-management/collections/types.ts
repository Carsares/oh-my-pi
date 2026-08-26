/** The virtual collection containing every currently eligible local skill. */
export const LOCAL_ALL_COLLECTION_ID = "local-all" as const;

export type CollectionId = string;
export type SkillId = string;

export interface SkillCollection {
	collectionId: CollectionId;
	name: string;
	description?: string;
	skillIds: SkillId[];
	revision: number;
	createdAt: string;
	updatedAt: string;
}

export interface LocalAllSkillCollection {
	collectionId: typeof LOCAL_ALL_COLLECTION_ID;
	name: string;
	description: string;
	skillIds: SkillId[];
	virtual: true;
}

export interface GlobalSkillCollectionsState {
	schemaVersion: 1;
	revision: number;
	defaultCollectionId: CollectionId;
	collections: SkillCollection[];
}

export interface SkillCollectionsSnapshot {
	state: GlobalSkillCollectionsState;
}

export interface SkillCollectionsListResult extends SkillCollectionsSnapshot {
	collections: Array<SkillCollection | LocalAllSkillCollection>;
}

export interface SkillCollectionGetResult extends SkillCollectionsSnapshot {
	collection: SkillCollection | LocalAllSkillCollection;
}

export interface CollectionMutationContext {
	expectedRevision: number;
}

export interface CollectionMutationResult extends SkillCollectionsSnapshot {
	changed: boolean;
	/** Present while the affected collection still exists. */
	collection?: SkillCollection;
}

export interface CreateCollectionParams {
	name: string;
	description?: string;
	skillIds?: readonly SkillId[];
}

export interface UpdateCollectionPatch {
	name?: string;
	description?: string | null;
	/** Replaces the complete member list when present. */
	skillIds?: readonly SkillId[];
}

export interface UpdateCollectionParams {
	collectionId: CollectionId;
	patch: UpdateCollectionPatch;
}
