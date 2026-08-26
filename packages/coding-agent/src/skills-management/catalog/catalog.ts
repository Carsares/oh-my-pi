import { createSkillId } from "./identity";
import type {
	SkillCatalogCandidate,
	SkillCatalogEntry,
	SkillCatalogState,
	SkillRootScanResult,
	SkillSourceRef,
	SuccessfulSkillRootScan,
} from "./types";

export function createEmptySkillCatalog(): SkillCatalogState {
	return { schemaVersion: 1, revision: 0, entries: [] };
}

function sourceKey(source: SkillSourceRef): string {
	return `${source.providerId}\0${source.sourceRoot}\0${source.discoveredPath}`;
}

function rootKey(root: Pick<SkillSourceRef, "providerId" | "sourceRoot">): string {
	return `${root.providerId}\0${root.sourceRoot}`;
}

function compareSource(left: SkillSourceRef, right: SkillSourceRef): number {
	return sourceKey(left).localeCompare(sourceKey(right));
}

function sourceFromCandidate(candidate: SkillCatalogCandidate): SkillSourceRef {
	return {
		providerId: candidate.providerId,
		level: candidate.level,
		sourceRoot: candidate.sourceRoot,
		discoveredPath: candidate.discoveredPath,
		...(candidate.projectRoot === undefined ? {} : { projectRoot: candidate.projectRoot }),
		discoveryKind: candidate.discoveryKind,
		providerPriority: candidate.providerPriority,
		...(candidate.projectDistance === undefined ? {} : { projectDistance: candidate.projectDistance }),
	};
}

function copyEntry(entry: SkillCatalogEntry): SkillCatalogEntry {
	return { ...entry, sources: entry.sources.map(source => ({ ...source })) };
}

function validateSuccessfulScan(scan: SuccessfulSkillRootScan): void {
	for (const candidate of scan.candidates) {
		if (candidate.providerId !== scan.providerId || candidate.sourceRoot !== scan.sourceRoot) {
			throw new Error("Skill Catalog candidate does not belong to its successful root scan");
		}
	}
}

function groupCandidates(candidates: readonly SkillCatalogCandidate[]): Map<string, SkillCatalogCandidate[]> {
	const grouped = new Map<string, SkillCatalogCandidate[]>();
	for (const candidate of candidates) {
		const skillId = createSkillId(candidate.canonicalPath);
		const group = grouped.get(skillId) ?? [];
		group.push(candidate);
		grouped.set(skillId, group);
	}
	for (const group of grouped.values()) group.sort((left, right) => compareSource(left, right));
	return grouped;
}

function updateDescriptor(
	existing: SkillCatalogEntry | undefined,
	descriptor: SkillCatalogCandidate,
	sources: SkillSourceRef[],
	now: string,
): SkillCatalogEntry {
	const skillId = createSkillId(descriptor.canonicalPath);
	if (existing && existing.canonicalPath !== descriptor.canonicalPath) {
		throw new Error(`Catalog path mismatch for skill ${skillId}`);
	}
	const name = descriptor.name;
	const description = descriptor.description;
	const lastKnownName = name ?? existing?.lastKnownName;
	const lastKnownDescription = description ?? existing?.lastKnownDescription;
	return {
		skillId,
		canonicalPath: descriptor.canonicalPath,
		...(name === undefined ? {} : { name }),
		...(description === undefined ? {} : { description }),
		...(lastKnownName === undefined ? {} : { lastKnownName }),
		...(lastKnownDescription === undefined ? {} : { lastKnownDescription }),
		status: descriptor.status,
		...(descriptor.parseError === undefined ? {} : { parseError: descriptor.parseError }),
		sources,
		firstSeenAt: existing?.firstSeenAt ?? now,
		lastSeenAt: now,
	};
}

/**
 * Replace sources only for roots whose scans succeeded. Failed roots retain their
 * previous sources and cannot make an entry missing.
 */
export function replaceSkillCatalogRootSources(
	state: SkillCatalogState,
	scans: readonly SkillRootScanResult[],
	now = new Date().toISOString(),
): SkillCatalogState {
	const successfulScans = scans.filter((scan): scan is SuccessfulSkillRootScan => scan.status === "success");
	if (successfulScans.length === 0) return structuredClone(state);
	for (const scan of successfulScans) validateSuccessfulScan(scan);

	const scannedRoots = new Set(successfulScans.map(rootKey));
	const entriesById = new Map(
		state.entries.map(entry => {
			const retainedSources = entry.sources.filter(source => !scannedRoots.has(rootKey(source)));
			return [entry.skillId, { ...copyEntry(entry), sources: retainedSources }] as const;
		}),
	);
	const candidates = successfulScans.flatMap(scan => scan.candidates);

	for (const [skillId, group] of groupCandidates(candidates)) {
		const descriptor = group[0];
		if (group.some(candidate => candidate.canonicalPath !== descriptor.canonicalPath)) {
			throw new Error(`Skill identity collision for ${skillId}`);
		}
		const existing = entriesById.get(skillId);
		const sourcesByKey = new Map((existing?.sources ?? []).map(source => [sourceKey(source), source]));
		for (const candidate of group) {
			const source = sourceFromCandidate(candidate);
			sourcesByKey.set(sourceKey(source), source);
		}
		entriesById.set(
			skillId,
			updateDescriptor(existing, descriptor, [...sourcesByKey.values()].sort(compareSource), now),
		);
	}

	for (const [skillId, entry] of entriesById) {
		if (entry.sources.length > 0) continue;
		const missing = {
			...copyEntry(entry),
			...(entry.name === undefined ? {} : { lastKnownName: entry.name }),
			...(entry.description === undefined ? {} : { lastKnownDescription: entry.description }),
			status: "missing" as const,
		};
		delete missing.name;
		delete missing.description;
		delete missing.parseError;
		entriesById.set(skillId, missing);
	}

	return {
		...state,
		entries: [...entriesById.values()].sort((left, right) => left.skillId.localeCompare(right.skillId)),
	};
}

export function getSkillCatalogEntry(state: SkillCatalogState, skillId: string): SkillCatalogEntry | undefined {
	const entry = state.entries.find(candidate => candidate.skillId === skillId);
	return entry ? copyEntry(entry) : undefined;
}
