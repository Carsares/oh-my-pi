export type SkillManagementErrorCode =
	| "collection_not_found"
	| "profile_invalid"
	| "session_busy"
	| "skill_not_found"
	| "skill_unavailable"
	| "stale_profile"
	| "stale_sync_preview";

export class SkillManagementError extends Error {
	readonly code: SkillManagementErrorCode;
	readonly current?: unknown;

	constructor(code: SkillManagementErrorCode, message: string, current?: unknown) {
		super(message);
		this.name = "SkillManagementError";
		this.code = code;
		this.current = current;
	}
}
