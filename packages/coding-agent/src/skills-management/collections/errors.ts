import type { SkillCollectionsSnapshot } from "./types";

export type SkillCollectionsErrorCode =
	| "collection_in_use"
	| "collection_not_found"
	| "invalid_collection"
	| "local_all_read_only"
	| "stale_collections";

/** Domain error returned by Collection Repository mutations. */
export class SkillCollectionsError extends Error {
	readonly code: SkillCollectionsErrorCode;
	readonly current?: SkillCollectionsSnapshot;

	constructor(code: SkillCollectionsErrorCode, message: string, current?: SkillCollectionsSnapshot) {
		super(message);
		this.name = "SkillCollectionsError";
		this.code = code;
		this.current = current;
	}
}
