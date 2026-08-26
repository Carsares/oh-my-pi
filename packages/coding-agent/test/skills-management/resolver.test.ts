import { describe, expect, test } from "bun:test";
import type { SkillSourceRef } from "../../src/skills-management/catalog";
import {
	normalizeSkillRuntimeName,
	resolveEffectiveSkillSource,
	resolveSkillCandidates,
	type SkillResolutionCandidate,
} from "../../src/skills-management/resolver";

function source(overrides: Partial<SkillSourceRef> = {}): SkillSourceRef {
	return {
		providerId: "native",
		level: "user",
		sourceRoot: "/source",
		discoveredPath: "/source/SKILL.md",
		discoveryKind: "standard",
		providerPriority: 50,
		...overrides,
	};
}

function candidate(overrides: Partial<SkillResolutionCandidate> & Pick<SkillResolutionCandidate, "skillId">) {
	return {
		name: "review",
		canonicalPath: `/skills/${overrides.skillId}/SKILL.md`,
		effectiveSource: source({ discoveredPath: `/skills/${overrides.skillId}/SKILL.md` }),
		...overrides,
	};
}

describe("resolveSkillCandidates", () => {
	test("keeps runtime names case-sensitive like existing command lookup", () => {
		expect(normalizeSkillRuntimeName("Review")).toBe("Review");
		const result = resolveSkillCandidates([
			candidate({ skillId: "upper", name: "Review" }),
			candidate({ skillId: "lower", name: "review" }),
		]);
		expect(result.activeSkillIds).toEqual(["upper", "lower"]);
	});

	test("uses custom, authored provider priority, then managed precedence", () => {
		const result = resolveSkillCandidates([
			candidate({
				skillId: "managed",
				effectiveSource: source({ discoveryKind: "managed", providerPriority: 100 }),
			}),
			candidate({ skillId: "user" }),
			candidate({
				skillId: "project",
				effectiveSource: source({ level: "project", providerPriority: 60 }),
			}),
			candidate({
				skillId: "custom",
				effectiveSource: source({ discoveryKind: "custom", providerPriority: 0 }),
			}),
		]);
		expect(result.resolutions[0]).toMatchObject({
			activeSkillId: "custom",
			candidateSkillIds: ["custom", "project", "user", "managed"],
			shadowedSkillIds: ["project", "user", "managed"],
		});
	});

	test("uses provider priority and canonical path as deterministic tie breakers", () => {
		const result = resolveSkillCandidates([
			candidate({ skillId: "path-b", canonicalPath: "/b/SKILL.md" }),
			candidate({
				skillId: "priority",
				canonicalPath: "/z/SKILL.md",
				effectiveSource: source({ providerPriority: 60 }),
			}),
			candidate({ skillId: "path-a", canonicalPath: "/a/SKILL.md" }),
		]);
		expect(result.resolutions[0].candidateSkillIds).toEqual(["priority", "path-a", "path-b"]);
	});

	test("prefers project level within a provider and nearest project source", () => {
		const effective = resolveEffectiveSkillSource([
			source({ level: "user", discoveredPath: "/user/SKILL.md" }),
			source({ level: "project", projectDistance: 2, discoveredPath: "/far/SKILL.md" }),
			source({ level: "project", projectDistance: 0, discoveredPath: "/near/SKILL.md" }),
		]);
		expect(effective?.discoveredPath).toBe("/near/SKILL.md");
	});
});
