import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	SKILL_CATALOG_FILENAME,
	type SkillCatalogCandidate,
	SkillCatalogRepository,
	type SkillRootScanResult,
} from "../../src/skills-management/catalog";

const temporaryDirectories: string[] = [];
const NOW = new Date("2026-08-26T00:00:00.000Z");

function candidate(canonicalPath: string, providerId = "agents", sourceRoot = "/skills"): SkillCatalogCandidate {
	return {
		canonicalPath,
		discoveredPath: canonicalPath,
		sourceRoot,
		providerId,
		level: "user",
		discoveryKind: "standard",
		providerPriority: 50,
		name: path.basename(path.dirname(canonicalPath)),
		description: "Review code",
		status: "available",
	};
}

function success(providerId: string, sourceRoot: string, candidates: SkillCatalogCandidate[]): SkillRootScanResult {
	return { status: "success", providerId, sourceRoot, candidates };
}

function temporaryAgentDir(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-skill-catalog-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("SkillCatalogRepository", () => {
	test("writes YAML with one integer revision", async () => {
		const repository = new SkillCatalogRepository({ agentDir: temporaryAgentDir(), now: () => NOW });
		expect(path.basename(repository.filePath)).toBe(SKILL_CATALOG_FILENAME);
		expect((await repository.getSnapshot()).revision).toBe(0);

		const review = candidate("/skills/review/SKILL.md");
		const committed = await repository.commitRootScan(success("agents", "/skills", [review]));
		expect(committed.revision).toBe(1);
		expect(committed.entries[0].sources).toHaveLength(1);
		const content = fs.readFileSync(repository.filePath, "utf8");
		expect(content).toContain("revision: 1");
		expect(content).toContain("sources:");

		const reopened = new SkillCatalogRepository({ filePath: repository.filePath });
		expect(await reopened.getSnapshot()).toEqual(committed);
	});

	test("does not create or update the file for failed roots", async () => {
		const repository = new SkillCatalogRepository({ agentDir: temporaryAgentDir(), now: () => NOW });
		const failedScan: SkillRootScanResult = {
			status: "failed",
			providerId: "agents",
			sourceRoot: "/skills",
			error: "permission denied",
		};
		const failed = await repository.commitRootScan(failedScan);
		expect(failed.revision).toBe(0);
		expect(fs.existsSync(repository.filePath)).toBe(false);

		await repository.commitRootScan(success("agents", "/skills", [candidate("/skills/review/SKILL.md")]));
		const beforeFailure = fs.readFileSync(repository.filePath, "utf8");
		const retained = await repository.commitRootScan(failedScan);
		expect(retained.revision).toBe(1);
		expect(fs.readFileSync(repository.filePath, "utf8")).toBe(beforeFailure);
	});

	test("replaces sources only for a successfully scanned root", async () => {
		const repository = new SkillCatalogRepository({ agentDir: temporaryAgentDir(), now: () => NOW });
		await repository.commitRootScans([
			success("agents", "/skills", [candidate("/skills/review/SKILL.md")]),
			success("codex", "/codex-skills", [candidate("/skills/review/SKILL.md", "codex", "/codex-skills")]),
		]);
		await repository.commitRootScan(success("agents", "/skills", []));
		const retained = await repository.getSnapshot();
		expect(retained.entries[0].sources.map(source => source.providerId)).toEqual(["codex"]);

		await repository.commitRootScan(success("codex", "/codex-skills", []));
		const missing = await repository.getSnapshot();
		expect(missing.entries[0]).toMatchObject({ status: "missing", sources: [] });
	});

	test("serializes concurrent process-style updates through the shared file lock", async () => {
		const agentDir = temporaryAgentDir();
		const left = new SkillCatalogRepository({ agentDir, now: () => NOW });
		const right = new SkillCatalogRepository({ agentDir, now: () => NOW });
		await Promise.all([
			left.commitRootScan(success("agents", "/skills", [candidate("/skills/review/SKILL.md")])),
			right.commitRootScan(
				success("codex", "/codex-skills", [candidate("/codex-skills/test/SKILL.md", "codex", "/codex-skills")]),
			),
		]);

		const state = await left.getSnapshot();
		expect(state.revision).toBe(2);
		expect(state.entries).toHaveLength(2);
		expect(fs.readdirSync(agentDir).filter(file => file.endsWith(".tmp"))).toEqual([]);
	});
});
