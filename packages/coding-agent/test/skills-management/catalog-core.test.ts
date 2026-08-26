import { describe, expect, it } from "bun:test";
import {
	createEmptySkillCatalog,
	createSkillId,
	getSkillCatalogEntry,
	replaceSkillCatalogRootSources,
	type SkillCatalogCandidate,
	type SuccessfulSkillRootScan,
} from "../../src/skills-management/catalog";

const NOW = "2026-08-26T00:00:00.000Z";

function candidate(overrides: Partial<SkillCatalogCandidate> = {}): SkillCatalogCandidate {
	return {
		canonicalPath: "/Users/alice/.agents/skills/review/SKILL.md",
		discoveredPath: "/Users/alice/.agents/skills/review/SKILL.md",
		sourceRoot: "/Users/alice/.agents/skills",
		providerId: "agents",
		level: "user",
		discoveryKind: "standard",
		providerPriority: 50,
		name: "review",
		description: "Review changes",
		status: "available",
		...overrides,
	};
}

function success(
	candidates: SkillCatalogCandidate[],
	overrides: Partial<Pick<SuccessfulSkillRootScan, "providerId" | "sourceRoot">> = {},
): SuccessfulSkillRootScan {
	return {
		status: "success",
		providerId: candidates[0]?.providerId ?? "agents",
		sourceRoot: candidates[0]?.sourceRoot ?? "/Users/alice/.agents/skills",
		candidates,
		...overrides,
	};
}

describe("skill catalog root replacement", () => {
	it("keeps every source that resolves to the same canonical SKILL.md", () => {
		const codex = candidate({
			discoveredPath: "/Users/alice/.codex/skills/review/SKILL.md",
			sourceRoot: "/Users/alice/.codex/skills",
			providerId: "codex",
			providerPriority: 40,
		});
		const state = replaceSkillCatalogRootSources(
			createEmptySkillCatalog(),
			[success([candidate()]), success([codex])],
			NOW,
		);

		expect(state.entries).toHaveLength(1);
		expect(state.entries[0].sources).toHaveLength(2);
		expect(state.entries[0].sources.map(source => source.providerId).sort()).toEqual(["agents", "codex"]);
	});

	it("keeps same-name skills at different canonical paths as separate entries", () => {
		const projectPath = "/Users/alice/work/repo/.omp/skills/review/SKILL.md";
		const project = candidate({
			canonicalPath: projectPath,
			discoveredPath: projectPath,
			sourceRoot: "/Users/alice/work/repo/.omp/skills",
			providerId: "omp-project",
			level: "project",
		});
		const state = replaceSkillCatalogRootSources(
			createEmptySkillCatalog(),
			[success([candidate()]), success([project])],
			NOW,
		);

		expect(state.entries).toHaveLength(2);
		expect(new Set(state.entries.map(entry => entry.skillId)).size).toBe(2);
		expect(state.entries.map(entry => entry.name)).toEqual(["review", "review"]);
	});

	it("replaces only the successful root and marks an unreferenced entry missing", () => {
		const codex = candidate({
			discoveredPath: "/Users/alice/.codex/skills/review/SKILL.md",
			sourceRoot: "/Users/alice/.codex/skills",
			providerId: "codex",
		});
		const initial = replaceSkillCatalogRootSources(
			createEmptySkillCatalog(),
			[success([candidate()]), success([codex])],
			NOW,
		);
		const withoutAgents = replaceSkillCatalogRootSources(initial, [success([])], "2026-08-26T00:01:00.000Z");
		expect(withoutAgents.entries[0].sources.map(source => source.providerId)).toEqual(["codex"]);
		expect(withoutAgents.entries[0].status).toBe("available");

		const withoutAnySource = replaceSkillCatalogRootSources(
			withoutAgents,
			[success([], { providerId: "codex", sourceRoot: "/Users/alice/.codex/skills" })],
			"2026-08-26T00:02:00.000Z",
		);
		expect(withoutAnySource.entries[0]).toMatchObject({
			status: "missing",
			lastKnownName: "review",
			sources: [],
		});
		expect(withoutAnySource.entries[0].name).toBeUndefined();
	});

	it("does not modify sources or status for a failed root", () => {
		const initial = replaceSkillCatalogRootSources(createEmptySkillCatalog(), [success([candidate()])], NOW);
		const failed = replaceSkillCatalogRootSources(initial, [
			{
				status: "failed",
				providerId: "agents",
				sourceRoot: "/Users/alice/.agents/skills",
				error: "permission denied",
			},
		]);
		expect(failed).toEqual(initial);
	});

	it("keeps invalid Skills addressable by ID", () => {
		const state = replaceSkillCatalogRootSources(
			createEmptySkillCatalog(),
			[success([candidate({ name: undefined, status: "invalid", parseError: "Invalid frontmatter" })])],
			NOW,
		);
		expect(state.entries[0]).toMatchObject({ status: "invalid", parseError: "Invalid frontmatter" });
	});

	it("returns detached lookup values", () => {
		const state = replaceSkillCatalogRootSources(createEmptySkillCatalog(), [success([candidate()])], NOW);
		const entry = getSkillCatalogEntry(state, createSkillId(candidate().canonicalPath));
		expect(entry?.name).toBe("review");
		if (entry) entry.name = "changed";
		expect(getSkillCatalogEntry(state, createSkillId(candidate().canonicalPath))?.name).toBe("review");
	});
});
