import { describe, expect, it } from "bun:test";
import { createSkillId } from "../../src/skills-management/catalog";

describe("skill catalog identity", () => {
	it.each([
		["/home/alice/.agents/skills/review/SKILL.md", "904649c4-0834-5733-8aa2-8acd821a9a64"],
		["/Users/alice/.agents/skills/review/SKILL.md", "76fe38b2-5ad1-5bda-b9ba-098d1e426680"],
	] as const)("uses the realpath directly as the UUIDv5 name", (canonicalPath, expected) => {
		expect(createSkillId(canonicalPath)).toBe(expected);
	});

	it("does not add platform tags or normalize its realpath input", () => {
		expect(createSkillId("/tmp/skills/../review/SKILL.md")).not.toBe(createSkillId("/tmp/review/SKILL.md"));
	});

	it("changes only when the canonical path changes", () => {
		const path = "/Users/alice/.agents/skills/review/SKILL.md";
		expect(createSkillId(path)).toBe(createSkillId(path));
		expect(createSkillId(path)).not.toBe(createSkillId("/Users/alice/.agents/skills/test/SKILL.md"));
	});

	it("rejects an empty identity input", () => {
		expect(() => createSkillId("")).toThrow("must not be empty");
	});
});
