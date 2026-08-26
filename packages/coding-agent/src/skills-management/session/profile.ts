import { SESSION_SKILLS_PROFILE_CUSTOM_TYPE, type SessionEntry } from "../../session/session-entries";
import type {
	CollectionSnapshot,
	CreateSessionSkillsProfileParams,
	ReducedSessionSkillsProfile,
	SessionSkillIdsDiff,
	SessionSkillsProfile,
	SessionSkillsProfileMutation,
} from "./types";
import { SessionSkillsProfileError } from "./types";

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function cloneCollection(collection: CollectionSnapshot): CollectionSnapshot {
	return { ...collection, skillIds: unique(collection.skillIds) };
}

export function cloneSessionSkillsProfile(profile: SessionSkillsProfile): SessionSkillsProfile {
	return {
		...profile,
		baseCollection: cloneCollection(profile.baseCollection),
		additionalCollections: profile.additionalCollections.map(cloneCollection),
		addedSkillIds: [...profile.addedSkillIds],
		disabledSkillIds: [...profile.disabledSkillIds],
	};
}

function normalizeAdditionalCollections(
	collections: readonly CollectionSnapshot[],
	baseCollectionId: string,
): CollectionSnapshot[] {
	const seen = new Set<string>([baseCollectionId]);
	const result: CollectionSnapshot[] = [];
	for (const collection of collections) {
		if (seen.has(collection.collectionId)) continue;
		seen.add(collection.collectionId);
		result.push(cloneCollection(collection));
	}
	return result;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isCollectionSnapshot(value: unknown): value is CollectionSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<CollectionSnapshot>;
	return (
		typeof candidate.collectionId === "string" &&
		typeof candidate.collectionName === "string" &&
		(candidate.sourceCollectionRevision === undefined ||
			(Number.isInteger(candidate.sourceCollectionRevision) && candidate.sourceCollectionRevision >= 0)) &&
		isStringArray(candidate.skillIds) &&
		typeof candidate.capturedAt === "string"
	);
}

export function isSessionSkillsProfile(value: unknown): value is SessionSkillsProfile {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<SessionSkillsProfile>;
	return (
		candidate.schemaVersion === 1 &&
		Number.isInteger(candidate.revision) &&
		(candidate.revision ?? 0) >= 1 &&
		isCollectionSnapshot(candidate.baseCollection) &&
		Array.isArray(candidate.additionalCollections) &&
		candidate.additionalCollections.every(isCollectionSnapshot) &&
		isStringArray(candidate.addedSkillIds) &&
		isStringArray(candidate.disabledSkillIds) &&
		typeof candidate.updatedAt === "string"
	);
}

export function createSessionSkillsProfile(params: CreateSessionSkillsProfileParams): SessionSkillsProfile {
	const baseCollection = cloneCollection(params.baseCollection);
	return {
		schemaVersion: 1,
		revision: 1,
		baseCollection,
		additionalCollections: normalizeAdditionalCollections(
			params.additionalCollections ?? [],
			baseCollection.collectionId,
		),
		addedSkillIds: unique(params.addedSkillIds ?? []),
		disabledSkillIds: unique(params.disabledSkillIds ?? []),
		updatedAt: params.updatedAt ?? new Date().toISOString(),
	};
}

export function resolveSessionSkillIds(profile: SessionSkillsProfile): string[] {
	const disabled = new Set(profile.disabledSkillIds);
	return memberSessionSkillIds(profile).filter(skillId => !disabled.has(skillId));
}

function memberSessionSkillIds(profile: SessionSkillsProfile): string[] {
	return unique([
		...profile.baseCollection.skillIds,
		...profile.additionalCollections.flatMap(collection => collection.skillIds),
		...profile.addedSkillIds,
	]);
}

/** Recovers the current Profile from the latest Profile entry on an active branch. */
export function reduceSessionSkillsProfileEntries(entries: readonly SessionEntry[]): SessionSkillsProfile | undefined {
	const entry = entries.findLast(
		candidate => candidate.type === "custom" && candidate.customType === SESSION_SKILLS_PROFILE_CUSTOM_TYPE,
	);
	if (!entry) return undefined;
	if (entry.type !== "custom" || !isSessionSkillsProfile(entry.data)) {
		throw new SessionSkillsProfileError("profile_invalid", "The latest Session Skills Profile entry is invalid");
	}
	return cloneSessionSkillsProfile(entry.data);
}

function sameCollection(left: CollectionSnapshot, right: CollectionSnapshot): boolean {
	return (
		left.collectionId === right.collectionId &&
		left.collectionName === right.collectionName &&
		left.sourceCollectionRevision === right.sourceCollectionRevision &&
		left.skillIds.length === right.skillIds.length &&
		left.skillIds.every((skillId, index) => skillId === right.skillIds[index])
	);
}

function profilesEqual(left: SessionSkillsProfile, right: SessionSkillsProfile): boolean {
	return (
		sameCollection(left.baseCollection, right.baseCollection) &&
		left.additionalCollections.length === right.additionalCollections.length &&
		left.additionalCollections.every((collection, index) =>
			sameCollection(collection, right.additionalCollections[index]),
		) &&
		left.addedSkillIds.length === right.addedSkillIds.length &&
		left.addedSkillIds.every((skillId, index) => skillId === right.addedSkillIds[index]) &&
		left.disabledSkillIds.length === right.disabledSkillIds.length &&
		left.disabledSkillIds.every((skillId, index) => skillId === right.disabledSkillIds[index])
	);
}

function diffSkillIds(before: readonly string[], after: readonly string[]): SessionSkillIdsDiff {
	const beforeSet = new Set(before);
	const afterSet = new Set(after);
	return {
		addedSkillIds: after.filter(skillId => !beforeSet.has(skillId)),
		removedSkillIds: before.filter(skillId => !afterSet.has(skillId)),
	};
}

function assertSyncCollections(
	profile: SessionSkillsProfile,
	baseCollection: CollectionSnapshot,
	additionalCollections: readonly CollectionSnapshot[],
): void {
	const currentIds = new Set(profile.additionalCollections.map(collection => collection.collectionId));
	const nextIds = new Set(additionalCollections.map(collection => collection.collectionId));
	if (
		baseCollection.collectionId !== profile.baseCollection.collectionId ||
		currentIds.size !== nextIds.size ||
		[...currentIds].some(collectionId => !nextIds.has(collectionId))
	) {
		throw new SessionSkillsProfileError(
			"invalid_sync_collections",
			"Sync may refresh selected collection snapshots but cannot change the selected collection set",
		);
	}
}

export function reduceSessionSkillsProfile(
	profile: SessionSkillsProfile,
	mutation: SessionSkillsProfileMutation,
	updatedAt: string = new Date().toISOString(),
): ReducedSessionSkillsProfile {
	const beforeSkillIds = resolveSessionSkillIds(profile);
	const next = cloneSessionSkillsProfile(profile);

	switch (mutation.type) {
		case "set-base-collection": {
			next.baseCollection = cloneCollection(mutation.collection);
			next.additionalCollections = next.additionalCollections.filter(
				collection => collection.collectionId !== next.baseCollection.collectionId,
			);
			break;
		}
		case "add-collection": {
			if (mutation.collection.collectionId === next.baseCollection.collectionId) break;
			const collection = cloneCollection(mutation.collection);
			const index = next.additionalCollections.findIndex(item => item.collectionId === collection.collectionId);
			if (index === -1) next.additionalCollections.push(collection);
			else next.additionalCollections[index] = collection;
			break;
		}
		case "remove-collection":
			next.additionalCollections = next.additionalCollections.filter(
				collection => collection.collectionId !== mutation.collectionId,
			);
			break;
		case "add-skill":
			next.addedSkillIds = unique([...next.addedSkillIds, mutation.skillId]);
			next.disabledSkillIds = next.disabledSkillIds.filter(skillId => skillId !== mutation.skillId);
			break;
		case "remove-skill":
			next.addedSkillIds = next.addedSkillIds.filter(skillId => skillId !== mutation.skillId);
			break;
		case "disable-skill":
			next.disabledSkillIds = unique([...next.disabledSkillIds, mutation.skillId]);
			break;
		case "restore-skill":
			next.disabledSkillIds = next.disabledSkillIds.filter(skillId => skillId !== mutation.skillId);
			break;
		case "activate-skill": {
			next.addedSkillIds = unique([...next.addedSkillIds, mutation.skillId]);
			next.disabledSkillIds = next.disabledSkillIds.filter(skillId => skillId !== mutation.skillId);
			const memberIds = new Set(memberSessionSkillIds(next));
			const conflicts = mutation.conflictingSkillIds.filter(
				skillId => skillId !== mutation.skillId && memberIds.has(skillId),
			);
			next.disabledSkillIds = unique([...next.disabledSkillIds, ...conflicts]);
			break;
		}
		case "sync": {
			const baseCollection = cloneCollection(mutation.snapshots.baseCollection);
			const additionalCollections = normalizeAdditionalCollections(
				mutation.snapshots.additionalCollections,
				baseCollection.collectionId,
			);
			assertSyncCollections(next, baseCollection, additionalCollections);
			next.baseCollection = baseCollection;
			next.additionalCollections = additionalCollections;
			break;
		}
	}

	next.additionalCollections = normalizeAdditionalCollections(
		next.additionalCollections,
		next.baseCollection.collectionId,
	);
	next.addedSkillIds = unique(next.addedSkillIds);
	next.disabledSkillIds = unique(next.disabledSkillIds);
	const changed = !profilesEqual(profile, next);
	if (changed) {
		next.revision = profile.revision + 1;
		next.updatedAt = updatedAt;
	}
	const effectiveSkillIds = resolveSessionSkillIds(next);
	return { changed, profile: next, effectiveSkillIds, diff: diffSkillIds(beforeSkillIds, effectiveSkillIds) };
}
