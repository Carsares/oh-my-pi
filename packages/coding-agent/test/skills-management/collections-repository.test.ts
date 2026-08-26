import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	LOCAL_ALL_COLLECTION_ID,
	SkillCollectionsError,
	SkillCollectionsRepository,
} from "../../src/skills-management/collections";

const temporaryDirectories: string[] = [];

function createRepository(now = new Date("2026-08-26T00:00:00.000Z")): SkillCollectionsRepository {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-skill-collections-"));
	temporaryDirectories.push(agentDir);
	return new SkillCollectionsRepository({ agentDir, now: () => now });
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("SkillCollectionsRepository", () => {
	test("starts with the virtual local-all collection as default without writing a file", async () => {
		const repository = createRepository();
		const result = await repository.list(["skill-b", "skill-a", "skill-b"]);

		expect(result.state).toEqual({
			schemaVersion: 1,
			revision: 0,
			defaultCollectionId: LOCAL_ALL_COLLECTION_ID,
			collections: [],
		});
		expect(result.collections[0]).toEqual({
			collectionId: LOCAL_ALL_COLLECTION_ID,
			name: "Current workspace available skills",
			description: "All currently available and eligible skills in this workspace.",
			skillIds: ["skill-b", "skill-a"],
			virtual: true,
		});
		expect((await repository.get(LOCAL_ALL_COLLECTION_ID, ["skill-a"])).collection.skillIds).toEqual(["skill-a"]);
		expect(fs.existsSync(repository.filePath)).toBe(false);
	});

	test("creates, updates, reloads, and deletes a custom collection", async () => {
		const repository = createRepository();
		const created = await repository.create(
			{
				name: "Review",
				description: "Review helpers",
				skillIds: ["skill-a", "skill-a", "skill-b"],
			},
			{ expectedRevision: 0 },
		);

		expect(created.changed).toBe(true);
		expect(created.collection?.collectionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(created.collection?.skillIds).toEqual(["skill-a", "skill-b"]);
		expect(created.collection?.revision).toBe(1);
		expect(created.state.revision).toBe(1);
		const collectionId = created.collection?.collectionId;
		if (!collectionId) throw new Error("Expected the created collection ID");

		const updated = await repository.update(
			{
				collectionId,
				patch: { name: "Code review", description: null, skillIds: ["skill-c"] },
			},
			{ expectedRevision: created.state.revision },
		);
		expect(updated.collection).toMatchObject({
			collectionId,
			name: "Code review",
			skillIds: ["skill-c"],
			revision: 2,
		});
		expect(updated.collection).not.toHaveProperty("description");

		const reopened = new SkillCollectionsRepository({ filePath: repository.filePath });
		const reloaded = await reopened.getSnapshot();
		expect(reloaded.state).toEqual(updated.state);

		const setDefault = await reopened.setDefault(collectionId, {
			expectedRevision: reloaded.state.revision,
		});
		expect(setDefault.state.defaultCollectionId).toBe(collectionId);
		await expect(
			reopened.delete(collectionId, { expectedRevision: setDefault.state.revision }),
		).rejects.toMatchObject({ code: "collection_in_use" });

		const resetDefault = await reopened.setDefault(LOCAL_ALL_COLLECTION_ID, {
			expectedRevision: setDefault.state.revision,
		});
		const deleted = await reopened.delete(collectionId, { expectedRevision: resetDefault.state.revision });
		expect(deleted.state.collections).toEqual([]);
	});

	test("rejects stale mutations and returns the current state", async () => {
		const repository = createRepository();
		const created = await repository.create({ name: "One" }, { expectedRevision: 0 });

		let error: unknown;
		try {
			await repository.create({ name: "Two" }, { expectedRevision: 0 });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(SkillCollectionsError);
		expect(error).toMatchObject({ code: "stale_collections" });
		expect((error as SkillCollectionsError).current?.state.revision).toBe(created.state.revision);
	});

	test("generates a distinct collection ID for each successful create", async () => {
		const repository = createRepository();
		const first = await repository.create({ name: "One" }, { expectedRevision: 0 });
		const second = await repository.create({ name: "Two" }, { expectedRevision: first.state.revision });
		expect(first.collection?.collectionId).not.toBe(second.collection?.collectionId);
	});

	test("does not write or advance revisions for a no-op", async () => {
		const repository = createRepository();
		const created = await repository.create({ name: "One", skillIds: ["skill-a"] }, { expectedRevision: 0 });
		const collectionId = created.collection?.collectionId;
		if (!collectionId) throw new Error("Expected the created collection ID");
		const beforeBytes = fs.readFileSync(repository.filePath, "utf8");

		const result = await repository.update(
			{ collectionId, patch: { name: "One", skillIds: ["skill-a", "skill-a"] } },
			{ expectedRevision: created.state.revision },
		);
		expect(result.changed).toBe(false);
		expect(result.state.revision).toBe(1);
		expect(fs.readFileSync(repository.filePath, "utf8")).toBe(beforeBytes);
	});
});
