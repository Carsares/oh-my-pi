import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getCapabilityInfo } from "../../capability";
import { skillCapability } from "../../capability/skill";
import type { LoadIssue, LoadRootScanResult } from "../../capability/types";
import type { SkillsSettings } from "../../config/settings";
import { type Skill as CapabilitySkill, loadCapability } from "../../discovery";
import { scanSkillsFromDir } from "../../discovery/helpers";
import { expandTilde } from "../../tools/path-utils";
import type { SkillCatalogCandidate, SkillDiscoveryKind, SkillRootScanResult } from "./types";

export interface SkillCatalogDiscoveryResult {
	rootScans: SkillRootScanResult[];
	providerErrors: Array<{ providerId: string; error: string }>;
}

function rootKey(root: Pick<LoadRootScanResult, "providerId" | "sourceRoot">): string {
	return `${root.providerId}\0${root.sourceRoot}`;
}

function createRootScans(
	candidates: readonly SkillCatalogCandidate[],
	rootResults: readonly LoadRootScanResult[],
): SkillRootScanResult[] {
	const scans = new Map<string, SkillRootScanResult>();
	for (const root of rootResults) {
		const sourceRoot = path.resolve(root.sourceRoot);
		const key = rootKey({ providerId: root.providerId, sourceRoot });
		const existing = scans.get(key);
		if (existing?.status === "failed") continue;
		if (root.status === "failed") {
			scans.set(key, {
				status: "failed",
				providerId: root.providerId,
				sourceRoot,
				...(root.error === undefined ? {} : { error: root.error }),
			});
		} else if (!existing) {
			scans.set(key, { status: "success", providerId: root.providerId, sourceRoot, candidates: [] });
		}
	}
	for (const candidate of candidates) {
		const key = rootKey(candidate);
		const existing = scans.get(key);
		if (existing?.status === "failed") continue;
		if (existing) existing.candidates.push(candidate);
		else {
			scans.set(key, {
				status: "success",
				providerId: candidate.providerId,
				sourceRoot: candidate.sourceRoot,
				candidates: [candidate],
			});
		}
	}
	return [...scans.values()];
}

function sourceRootForSkill(skillPath: string): string {
	const skillDirectory = path.dirname(skillPath);
	return path.basename(skillPath).toLowerCase() === "skill.md" ? path.dirname(skillDirectory) : skillDirectory;
}

function discoveryKind(providerId: string): SkillDiscoveryKind {
	if (providerId === "omp-managed") return "managed";
	if (providerId.includes("plugin")) return "plugin";
	return "standard";
}

function projectSourceLocation(sourceRoot: string, cwd: string): { projectRoot: string; projectDistance: number } {
	const resolvedCwd = path.resolve(cwd);
	let candidateRoot = path.resolve(sourceRoot);
	while (path.dirname(candidateRoot) !== candidateRoot) {
		const relative = path.relative(candidateRoot, resolvedCwd);
		if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
			const projectDistance = relative === "" ? 0 : relative.split(path.sep).filter(Boolean).length;
			return { projectRoot: candidateRoot, projectDistance };
		}
		candidateRoot = path.dirname(candidateRoot);
	}
	return { projectRoot: resolvedCwd, projectDistance: 0 };
}

async function candidateFromSkill(
	skill: CapabilitySkill,
	providerPriority: number,
	kind: SkillDiscoveryKind,
	cwd: string,
	declaredSourceRoot = sourceRootForSkill(skill.path),
): Promise<SkillCatalogCandidate> {
	const discoveredPath = path.resolve(skill.path);
	const sourceRoot = path.resolve(declaredSourceRoot);
	const projectLocation = skill.level === "project" ? projectSourceLocation(sourceRoot, cwd) : undefined;
	return {
		canonicalPath: await fs.realpath(discoveredPath),
		discoveredPath,
		sourceRoot,
		providerId: skill._source.provider,
		level: skill.level,
		...projectLocation,
		discoveryKind: kind,
		providerPriority,
		name: skill.name,
		description: typeof skill.frontmatter?.description === "string" ? skill.frontmatter.description : undefined,
		status: "available",
	};
}

async function candidateFromIssue(
	issue: LoadIssue,
	providerPriority: number,
	kind: SkillDiscoveryKind,
	cwd: string,
): Promise<SkillCatalogCandidate> {
	const level = issue._source.level === "project" ? "project" : "user";
	const projectLocation = level === "project" ? projectSourceLocation(issue.sourceRoot, cwd) : undefined;
	return {
		canonicalPath: await fs.realpath(issue.path),
		discoveredPath: path.resolve(issue.path),
		sourceRoot: path.resolve(issue.sourceRoot),
		providerId: issue._source.provider,
		level,
		...projectLocation,
		discoveryKind: kind,
		providerPriority,
		...(issue.name === undefined ? {} : { name: issue.name }),
		...(issue.description === undefined ? {} : { description: issue.description }),
		status: "invalid",
		parseError: issue.message,
	};
}

/** Collect the pre-dedup Skill candidates already exposed by registered OMP providers. */
export async function discoverSkillCatalogCandidates(
	cwd: string,
	settings: Pick<SkillsSettings, "customDirectories">,
): Promise<SkillCatalogDiscoveryResult> {
	const result = await loadCapability<CapabilitySkill>(skillCapability.id, {
		cwd,
		includeDisabled: true,
		includeInvalid: true,
	});
	const priorities = new Map(
		(getCapabilityInfo(skillCapability.id)?.providers ?? []).map(provider => [provider.id, provider.priority]),
	);
	const rootResults = [...(result.rootScans ?? [])];
	const candidates = await Promise.all(
		result.all.map(skill =>
			candidateFromSkill(
				skill,
				priorities.get(skill._source.provider) ?? 0,
				discoveryKind(skill._source.provider),
				cwd,
			),
		),
	);
	candidates.push(
		...(await Promise.all(
			(result.issues ?? []).map(issue =>
				candidateFromIssue(
					issue,
					priorities.get(issue._source.provider) ?? 0,
					discoveryKind(issue._source.provider),
					cwd,
				),
			),
		)),
	);

	for (const configuredDirectory of settings.customDirectories ?? []) {
		const directory = path.resolve(expandTilde(configuredDirectory));
		const custom = await scanSkillsFromDir(
			{ cwd, home: os.homedir(), repoRoot: null },
			{ dir: directory, providerId: "custom", level: "user", requireDescription: true },
		);
		candidates.push(
			...(await Promise.all(custom.items.map(skill => candidateFromSkill(skill, 0, "custom", cwd, directory)))),
			...(await Promise.all(custom.issues?.map(issue => candidateFromIssue(issue, 0, "custom", cwd)) ?? [])),
		);
		rootResults.push(...(custom.rootScans ?? []));
	}
	return {
		rootScans: createRootScans(candidates, rootResults),
		providerErrors: result.providerErrors ?? [],
	};
}
