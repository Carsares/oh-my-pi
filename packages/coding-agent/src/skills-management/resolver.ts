import type { SkillSourceRef } from "./catalog";

export interface SkillResolutionCandidate {
	skillId: string;
	name: string;
	canonicalPath: string;
	effectiveSource: SkillSourceRef;
}

export interface SkillNameResolution {
	name: string;
	activeSkillId: string;
	candidateSkillIds: string[];
	shadowedSkillIds: string[];
}

export interface ResolvedSkillCandidates {
	activeSkillIds: string[];
	shadowedSkillIds: string[];
	resolutions: SkillNameResolution[];
}

/** Keep the runtime key identical to the existing case-sensitive command and skill URL lookup. */
export function normalizeSkillRuntimeName(name: string): string {
	return name;
}

function authoredRank(source: SkillSourceRef): number {
	if (source.discoveryKind === "custom") return 2;
	return source.discoveryKind === "managed" ? 0 : 1;
}

/** Preserve existing precedence and provide one deterministic order for all consumers. */
export function compareSkillSources(left: SkillSourceRef, right: SkillSourceRef): number {
	const authoredDifference = authoredRank(right) - authoredRank(left);
	if (authoredDifference !== 0) return authoredDifference;
	const priorityDifference = right.providerPriority - left.providerPriority;
	if (priorityDifference !== 0) return priorityDifference;
	if (left.providerId === right.providerId && left.level !== right.level) {
		return left.level === "project" ? -1 : 1;
	}
	if (left.level === "project" && right.level === "project") {
		const distanceDifference =
			(left.projectDistance ?? Number.MAX_SAFE_INTEGER) - (right.projectDistance ?? Number.MAX_SAFE_INTEGER);
		if (distanceDifference !== 0) return distanceDifference;
	}
	const leftKey = `${left.providerId}\0${left.sourceRoot}\0${left.discoveredPath}`;
	const rightKey = `${right.providerId}\0${right.sourceRoot}\0${right.discoveredPath}`;
	return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/** Choose the authoritative source relationship for an eligible Catalog entry. */
export function resolveEffectiveSkillSource(sources: readonly SkillSourceRef[]): SkillSourceRef | undefined {
	return [...sources].sort(compareSkillSources)[0];
}

function compareCandidates(left: SkillResolutionCandidate, right: SkillResolutionCandidate): number {
	const sourceDifference = compareSkillSources(left.effectiveSource, right.effectiveSource);
	if (sourceDifference !== 0) return sourceDifference;
	return left.canonicalPath < right.canonicalPath ? -1 : left.canonicalPath > right.canonicalPath ? 1 : 0;
}

/** Resolve one runtime winner for every case-sensitive Skill name. */
export function resolveSkillCandidates(candidates: readonly SkillResolutionCandidate[]): ResolvedSkillCandidates {
	const groups = new Map<string, SkillResolutionCandidate[]>();
	for (const candidate of candidates) {
		const name = normalizeSkillRuntimeName(candidate.name);
		const group = groups.get(name);
		if (group) group.push(candidate);
		else groups.set(name, [candidate]);
	}

	const resolutions = Array.from(groups.entries())
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([name, group]) => {
			const ordered = [...group].sort(compareCandidates);
			return {
				name,
				activeSkillId: ordered[0].skillId,
				candidateSkillIds: ordered.map(candidate => candidate.skillId),
				shadowedSkillIds: ordered.slice(1).map(candidate => candidate.skillId),
			};
		});

	return {
		activeSkillIds: resolutions.map(resolution => resolution.activeSkillId),
		shadowedSkillIds: resolutions.flatMap(resolution => resolution.shadowedSkillIds),
		resolutions,
	};
}
