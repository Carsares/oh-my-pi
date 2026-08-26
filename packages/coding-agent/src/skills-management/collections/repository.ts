import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { YAML } from "bun";
import { SkillCollectionsError } from "./errors";
import {
	type CollectionId,
	type CollectionMutationContext,
	type CollectionMutationResult,
	type CreateCollectionParams,
	type GlobalSkillCollectionsState,
	LOCAL_ALL_COLLECTION_ID,
	type LocalAllSkillCollection,
	type SkillCollection,
	type SkillCollectionGetResult,
	type SkillCollectionsListResult,
	type SkillCollectionsSnapshot,
	type SkillId,
	type UpdateCollectionParams,
} from "./types";

const COLLECTIONS_FILENAME = "skill-collections.yml";
const LOCAL_ALL_NAME = "Current workspace available skills";
const LOCAL_ALL_DESCRIPTION = "All currently available and eligible skills in this workspace.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SkillCollectionsRepositoryOptions {
	agentDir?: string;
	filePath?: string;
	now?: () => Date;
}

function createDefaultState(): GlobalSkillCollectionsState {
	return {
		schemaVersion: 1,
		revision: 0,
		defaultCollectionId: LOCAL_ALL_COLLECTION_ID,
		collections: [],
	};
}

function cloneState(state: GlobalSkillCollectionsState): GlobalSkillCollectionsState {
	return structuredClone(state);
}

function formatSkillIds(skillIds: readonly SkillId[]): SkillId[] {
	const result: SkillId[] = [];
	const seen = new Set<string>();
	for (const skillId of skillIds) {
		if (typeof skillId !== "string" || skillId.trim().length === 0) {
			throw new SkillCollectionsError("invalid_collection", "Collection skill IDs must be non-empty strings");
		}
		if (seen.has(skillId)) continue;
		seen.add(skillId);
		result.push(skillId);
	}
	return result;
}

function requireNonEmpty(value: string, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new SkillCollectionsError("invalid_collection", `${field} must be a non-empty string`);
	}
	return value.trim();
}

function formatDescription(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new SkillCollectionsError("invalid_collection", "Collection description must be a string");
	}
	const description = value.trim();
	return description.length > 0 ? description : undefined;
}

function serializeState(state: GlobalSkillCollectionsState): string {
	return YAML.stringify(state, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCollection(value: unknown): SkillCollection {
	if (!isRecord(value)) throw new SkillCollectionsError("invalid_collection", "Collection entry must be a mapping");
	const { collectionId, name, description, skillIds, revision, createdAt, updatedAt } = value;
	if (
		typeof collectionId !== "string" ||
		!UUID_PATTERN.test(collectionId) ||
		collectionId === LOCAL_ALL_COLLECTION_ID
	) {
		throw new SkillCollectionsError("invalid_collection", "Persisted collection ID is invalid");
	}
	if (typeof name !== "string" || name.trim().length === 0) {
		throw new SkillCollectionsError("invalid_collection", `Collection ${collectionId} has an invalid name`);
	}
	if (description !== undefined && typeof description !== "string") {
		throw new SkillCollectionsError("invalid_collection", `Collection ${collectionId} has an invalid description`);
	}
	if (!Array.isArray(skillIds) || !skillIds.every(skillId => typeof skillId === "string" && skillId.length > 0)) {
		throw new SkillCollectionsError("invalid_collection", `Collection ${collectionId} has invalid skill IDs`);
	}
	if (!Number.isInteger(revision) || (revision as number) < 1) {
		throw new SkillCollectionsError("invalid_collection", `Collection ${collectionId} has an invalid revision`);
	}
	if (typeof createdAt !== "string" || typeof updatedAt !== "string") {
		throw new SkillCollectionsError("invalid_collection", `Collection ${collectionId} has invalid timestamps`);
	}
	const uniqueSkillIds = formatSkillIds(skillIds);
	if (uniqueSkillIds.length !== skillIds.length) {
		throw new SkillCollectionsError("invalid_collection", `Collection ${collectionId} contains duplicate skill IDs`);
	}
	return {
		collectionId,
		name,
		...(description === undefined ? {} : { description }),
		skillIds: uniqueSkillIds,
		revision: revision as number,
		createdAt,
		updatedAt,
	};
}

function parseState(content: string): GlobalSkillCollectionsState {
	let value: unknown;
	try {
		value = YAML.parse(content);
	} catch (error) {
		throw new SkillCollectionsError(
			"invalid_collection",
			`Unable to parse Skill Collections state: ${String(error)}`,
		);
	}
	if (!isRecord(value))
		throw new SkillCollectionsError("invalid_collection", "Skill Collections state must be a mapping");
	const { schemaVersion, revision, defaultCollectionId, collections } = value;
	if (schemaVersion !== 1 || !Number.isInteger(revision) || (revision as number) < 0) {
		throw new SkillCollectionsError("invalid_collection", "Skill Collections state version or revision is invalid");
	}
	if (typeof defaultCollectionId !== "string" || !Array.isArray(collections)) {
		throw new SkillCollectionsError("invalid_collection", "Skill Collections state fields are invalid");
	}
	const parsedCollections = collections.map(parseCollection);
	if (new Set(parsedCollections.map(collection => collection.collectionId)).size !== parsedCollections.length) {
		throw new SkillCollectionsError(
			"invalid_collection",
			"Skill Collections state contains duplicate collection IDs",
		);
	}
	if (
		defaultCollectionId !== LOCAL_ALL_COLLECTION_ID &&
		!parsedCollections.some(collection => collection.collectionId === defaultCollectionId)
	) {
		throw new SkillCollectionsError("invalid_collection", "Default Skill Collection does not exist");
	}
	return {
		schemaVersion: 1,
		revision: revision as number,
		defaultCollectionId,
		collections: parsedCollections,
	};
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
		await fs.promises.rename(temporaryPath, filePath);
	} catch (error) {
		await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
		throw error;
	}
}

/** Owns the persisted global custom collections and the virtual local-all collection. */
export class SkillCollectionsRepository {
	readonly filePath: string;
	readonly #now: () => Date;

	constructor(options: SkillCollectionsRepositoryOptions = {}) {
		this.filePath = options.filePath ?? path.join(options.agentDir ?? getAgentDir(), COLLECTIONS_FILENAME);
		this.#now = options.now ?? (() => new Date());
	}

	async getSnapshot(): Promise<SkillCollectionsSnapshot> {
		return { state: cloneState(await this.#read()) };
	}

	async list(eligibleSkillIds: readonly SkillId[] = [], includeVirtual = true): Promise<SkillCollectionsListResult> {
		const snapshot = await this.getSnapshot();
		const collections: Array<SkillCollection | LocalAllSkillCollection> = snapshot.state.collections.map(collection =>
			structuredClone(collection),
		);
		if (includeVirtual) collections.unshift(this.createLocalAll(eligibleSkillIds));
		return { ...snapshot, collections };
	}

	async get(collectionId: CollectionId, eligibleSkillIds: readonly SkillId[] = []): Promise<SkillCollectionGetResult> {
		const formattedCollectionId = requireNonEmpty(collectionId, "Collection ID");
		const snapshot = await this.getSnapshot();
		if (formattedCollectionId === LOCAL_ALL_COLLECTION_ID) {
			return { ...snapshot, collection: this.createLocalAll(eligibleSkillIds) };
		}
		const collection = snapshot.state.collections.find(candidate => candidate.collectionId === formattedCollectionId);
		if (!collection) {
			throw new SkillCollectionsError(
				"collection_not_found",
				`Skill Collection does not exist: ${formattedCollectionId}`,
			);
		}
		return { ...snapshot, collection: structuredClone(collection) };
	}

	createLocalAll(eligibleSkillIds: readonly SkillId[]): LocalAllSkillCollection {
		return {
			collectionId: LOCAL_ALL_COLLECTION_ID,
			name: LOCAL_ALL_NAME,
			description: LOCAL_ALL_DESCRIPTION,
			skillIds: formatSkillIds(eligibleSkillIds),
			virtual: true,
		};
	}

	async create(params: CreateCollectionParams, context: CollectionMutationContext): Promise<CollectionMutationResult> {
		const name = requireNonEmpty(params.name, "Collection name");
		const description = formatDescription(params.description);
		const skillIds = formatSkillIds(params.skillIds ?? []);
		return await this.#mutate(context, (state, now) => {
			const collection: SkillCollection = {
				collectionId: randomUUID(),
				name,
				...(description === undefined ? {} : { description }),
				skillIds,
				revision: 1,
				createdAt: now,
				updatedAt: now,
			};
			state.collections.push(collection);
			return { changed: true, collection };
		});
	}

	async update(params: UpdateCollectionParams, context: CollectionMutationContext): Promise<CollectionMutationResult> {
		const collectionId = requireNonEmpty(params.collectionId, "Collection ID");
		if (collectionId === LOCAL_ALL_COLLECTION_ID) {
			throw new SkillCollectionsError("local_all_read_only", "local-all cannot be modified");
		}
		const hasName = Object.hasOwn(params.patch, "name");
		const hasDescription = Object.hasOwn(params.patch, "description");
		const hasSkillIds = Object.hasOwn(params.patch, "skillIds");
		const name = hasName ? requireNonEmpty(params.patch.name as string, "Collection name") : undefined;
		const description = hasDescription ? formatDescription(params.patch.description ?? undefined) : undefined;
		const skillIds = hasSkillIds ? formatSkillIds(params.patch.skillIds ?? []) : undefined;
		return await this.#mutate(context, (state, now) => {
			const collection = state.collections.find(candidate => candidate.collectionId === collectionId);
			if (!collection) {
				throw new SkillCollectionsError("collection_not_found", `Skill Collection does not exist: ${collectionId}`);
			}
			const nextDescription = hasDescription ? description : collection.description;
			const nextSkillIds = hasSkillIds ? (skillIds as SkillId[]) : collection.skillIds;
			const changed =
				(hasName && name !== collection.name) ||
				(hasDescription && nextDescription !== collection.description) ||
				(hasSkillIds &&
					(nextSkillIds.length !== collection.skillIds.length ||
						nextSkillIds.some((skillId, index) => skillId !== collection.skillIds[index])));
			if (!changed) return { changed: false, collection };
			if (hasName) collection.name = name as string;
			if (hasDescription) {
				if (nextDescription === undefined) delete collection.description;
				else collection.description = nextDescription;
			}
			if (hasSkillIds) collection.skillIds = nextSkillIds;
			collection.revision += 1;
			collection.updatedAt = now;
			return { changed: true, collection };
		});
	}

	async delete(collectionId: CollectionId, context: CollectionMutationContext): Promise<CollectionMutationResult> {
		const formattedCollectionId = requireNonEmpty(collectionId, "Collection ID");
		if (formattedCollectionId === LOCAL_ALL_COLLECTION_ID) {
			throw new SkillCollectionsError("local_all_read_only", "local-all cannot be deleted");
		}
		return await this.#mutate(context, state => {
			const index = state.collections.findIndex(collection => collection.collectionId === formattedCollectionId);
			if (index < 0) {
				throw new SkillCollectionsError(
					"collection_not_found",
					`Skill Collection does not exist: ${formattedCollectionId}`,
				);
			}
			if (state.defaultCollectionId === formattedCollectionId) {
				throw new SkillCollectionsError(
					"collection_in_use",
					"Switch the default Skill Collection before deleting it",
				);
			}
			state.collections.splice(index, 1);
			return { changed: true };
		});
	}

	async setDefault(collectionId: CollectionId, context: CollectionMutationContext): Promise<CollectionMutationResult> {
		const formattedCollectionId = requireNonEmpty(collectionId, "Collection ID");
		return await this.#mutate(context, state => {
			if (
				formattedCollectionId !== LOCAL_ALL_COLLECTION_ID &&
				!state.collections.some(collection => collection.collectionId === formattedCollectionId)
			) {
				throw new SkillCollectionsError(
					"collection_not_found",
					`Skill Collection does not exist: ${formattedCollectionId}`,
				);
			}
			if (state.defaultCollectionId === formattedCollectionId) return { changed: false };
			state.defaultCollectionId = formattedCollectionId;
			return {
				changed: true,
				collection: state.collections.find(collection => collection.collectionId === formattedCollectionId),
			};
		});
	}

	async #read(): Promise<GlobalSkillCollectionsState> {
		try {
			const bytes = await fs.promises.readFile(this.filePath, "utf8");
			return parseState(bytes);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			return createDefaultState();
		}
	}

	async #mutate(
		context: CollectionMutationContext,
		change: (state: GlobalSkillCollectionsState, now: string) => { changed: boolean; collection?: SkillCollection },
	): Promise<CollectionMutationResult> {
		if (!Number.isInteger(context.expectedRevision) || context.expectedRevision < 0) {
			throw new SkillCollectionsError(
				"invalid_collection",
				"Expected Collections revision must be a non-negative integer",
			);
		}
		await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		return await withFileLock(this.filePath, async () => {
			const loaded = await this.#read();
			const current = { state: cloneState(loaded) };
			if (context.expectedRevision !== loaded.revision) {
				throw new SkillCollectionsError("stale_collections", "Skill Collections state has changed", current);
			}

			const nextState = cloneState(loaded);
			const now = this.#now().toISOString();
			const result = change(nextState, now);
			if (!result.changed) {
				return {
					changed: false,
					collection: result.collection ? structuredClone(result.collection) : undefined,
					state: cloneState(loaded),
				};
			}

			nextState.revision += 1;
			const bytes = serializeState(nextState);
			await writeAtomic(this.filePath, bytes);
			return {
				changed: true,
				collection: result.collection ? structuredClone(result.collection) : undefined,
				state: cloneState(nextState),
			};
		});
	}
}
