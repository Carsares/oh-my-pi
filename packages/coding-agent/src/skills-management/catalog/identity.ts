import { randomUUIDv5 } from "bun";

export const OMP_SKILL_NAMESPACE = "d83c4f85-75e1-53cd-a932-b3eeec86b574" as const;

/** Calculate the stable local identity from the native realpath of SKILL.md. */
export function createSkillId(canonicalPath: string): string {
	if (canonicalPath.length === 0) throw new Error("Canonical Skill path must not be empty");
	return randomUUIDv5(canonicalPath, OMP_SKILL_NAMESPACE);
}
