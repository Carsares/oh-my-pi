import { describe, expect, test } from "bun:test";
import { SESSION_SKILLS_PROFILE_CUSTOM_TYPE } from "../../src/session/session-entries";
import { SessionManager } from "../../src/session/session-manager";
import { MemorySessionStorage } from "../../src/session/session-storage";
import type {
	CollectionSnapshot,
	SessionSkillsMutationContext,
	SessionSkillsProfile,
} from "../../src/skills-management/session/index";
import {
	createSessionSkillsProfile,
	reduceSessionSkillsProfile,
	reduceSessionSkillsProfileEntries,
	resolveSessionSkillIds,
} from "../../src/skills-management/session/index";

function collection(collectionId: string, skillIds: string[], revision = 1): CollectionSnapshot {
	return {
		collectionId,
		collectionName: collectionId,
		sourceCollectionRevision: revision,
		skillIds,
		capturedAt: `2026-08-26T0${revision}:00:00.000Z`,
	};
}

function profile(overrides: Partial<SessionSkillsProfile> = {}): SessionSkillsProfile {
	return {
		...createSessionSkillsProfile({
			baseCollection: collection("base", ["base-a", "shared"]),
			additionalCollections: [collection("extra", ["extra-a", "shared"])],
			addedSkillIds: ["manual-a"],
			disabledSkillIds: ["shared"],
			updatedAt: "2026-08-26T00:00:00.000Z",
		}),
		...overrides,
	};
}

function context(manager: SessionManager, expectedRevision: number): SessionSkillsMutationContext {
	return { expectedActiveLeafId: manager.getLeafId(), expectedRevision };
}

describe("Session Skills Profile reducer", () => {
	test("resolves base and additional collections plus session additions minus disabled skills", () => {
		const value = profile();

		expect(resolveSessionSkillIds(value)).toEqual(["base-a", "extra-a", "manual-a"]);
		expect(value.baseCollection.skillIds).toEqual(["base-a", "shared"]);
		expect(value.disabledSkillIds).toEqual(["shared"]);
	});

	test("deduplicates profile sets without mutating create input", () => {
		const base = collection("base", ["a", "a"]);
		const value = createSessionSkillsProfile({
			baseCollection: base,
			additionalCollections: [collection("extra", ["b"]), collection("extra", ["ignored"])],
			addedSkillIds: ["c", "c"],
			disabledSkillIds: ["a", "a"],
		});

		base.skillIds.push("later");
		expect(value.baseCollection.skillIds).toEqual(["a"]);
		expect(value.additionalCollections.map(item => item.collectionId)).toEqual(["extra"]);
		expect(value.addedSkillIds).toEqual(["c"]);
		expect(value.disabledSkillIds).toEqual(["a"]);
	});

	test("recovers the latest full Profile from the current branch entries", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(SESSION_SKILLS_PROFILE_CUSTOM_TYPE, profile());
		manager.appendCustomEntry("unrelated", { value: 1 });
		manager.appendCustomEntry(
			SESSION_SKILLS_PROFILE_CUSTOM_TYPE,
			profile({ revision: 2, addedSkillIds: ["latest"] }),
		);

		expect(reduceSessionSkillsProfileEntries(manager.getBranch())).toMatchObject({
			revision: 2,
			addedSkillIds: ["latest"],
		});
	});

	test("rejects an invalid latest Profile instead of falling back to an older entry", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(SESSION_SKILLS_PROFILE_CUSTOM_TYPE, profile());
		manager.appendCustomEntry(SESSION_SKILLS_PROFILE_CUSTOM_TYPE, { schemaVersion: 2 });

		expect(() => reduceSessionSkillsProfileEntries(manager.getBranch())).toThrow(
			"latest Session Skills Profile entry is invalid",
		);
	});

	test("supports collection and session-only Skill mutations", () => {
		const setBase = reduceSessionSkillsProfile(
			profile(),
			{ type: "set-base-collection", collection: collection("replacement", ["replacement-a", "shared"]) },
			"2026-08-26T02:00:00.000Z",
		);
		expect(setBase.profile.revision).toBe(2);
		expect(setBase.profile.addedSkillIds).toEqual(["manual-a"]);
		expect(setBase.profile.disabledSkillIds).toEqual(["shared"]);

		const addedCollection = reduceSessionSkillsProfile(setBase.profile, {
			type: "add-collection",
			collection: collection("tools", ["tool-a"]),
		});
		expect(addedCollection.effectiveSkillIds).toContain("tool-a");

		const removedCollection = reduceSessionSkillsProfile(addedCollection.profile, {
			type: "remove-collection",
			collectionId: "tools",
		});
		expect(removedCollection.effectiveSkillIds).not.toContain("tool-a");

		const addedSkill = reduceSessionSkillsProfile(removedCollection.profile, {
			type: "add-skill",
			skillId: "shared",
		});
		expect(addedSkill.profile.disabledSkillIds).not.toContain("shared");
		expect(addedSkill.effectiveSkillIds).toContain("shared");

		const removedSkill = reduceSessionSkillsProfile(addedSkill.profile, { type: "remove-skill", skillId: "shared" });
		expect(removedSkill.profile.addedSkillIds).not.toContain("shared");
		expect(removedSkill.effectiveSkillIds).toContain("shared");
	});

	test("disables and restores a Skill without changing collection membership", () => {
		const disabled = reduceSessionSkillsProfile(profile(), { type: "disable-skill", skillId: "base-a" });
		expect(disabled.effectiveSkillIds).not.toContain("base-a");
		expect(disabled.profile.baseCollection.skillIds).toContain("base-a");

		const restored = reduceSessionSkillsProfile(disabled.profile, { type: "restore-skill", skillId: "base-a" });
		expect(restored.effectiveSkillIds).toContain("base-a");
	});

	test("activates one same-name candidate as one atomic Profile mutation", () => {
		const result = reduceSessionSkillsProfile(profile({ disabledSkillIds: ["winner"] }), {
			type: "activate-skill",
			skillId: "winner",
			conflictingSkillIds: ["base-a", "extra-a", "not-a-member", "winner"],
		});

		expect(result.profile.revision).toBe(2);
		expect(result.profile.addedSkillIds).toContain("winner");
		expect(result.profile.disabledSkillIds).toEqual(["base-a", "extra-a"]);
		expect(result.effectiveSkillIds).toEqual(["shared", "manual-a", "winner"]);
	});

	test("sync refreshes snapshots while preserving added and disabled Skill IDs", () => {
		const result = reduceSessionSkillsProfile(profile(), {
			type: "sync",
			snapshots: {
				baseCollection: collection("base", ["base-new", "shared"], 2),
				additionalCollections: [collection("extra", ["extra-new", "shared"], 2)],
			},
		});

		expect(result.profile.addedSkillIds).toEqual(["manual-a"]);
		expect(result.profile.disabledSkillIds).toEqual(["shared"]);
		expect(result.effectiveSkillIds).toEqual(["base-new", "extra-new", "manual-a"]);
		expect(result.diff).toEqual({
			addedSkillIds: ["base-new", "extra-new"],
			removedSkillIds: ["base-a", "extra-a"],
		});
	});

	test("set-based no-ops do not advance Profile revision", () => {
		const result = reduceSessionSkillsProfile(profile(), { type: "disable-skill", skillId: "shared" });

		expect(result.changed).toBeFalse();
		expect(result.profile.revision).toBe(1);
		expect(result.diff).toEqual({ addedSkillIds: [], removedSkillIds: [] });
	});

	test("sync ignores capture-time-only snapshot changes", () => {
		const current = profile();
		const result = reduceSessionSkillsProfile(current, {
			type: "sync",
			snapshots: {
				baseCollection: { ...current.baseCollection, capturedAt: "2026-08-26T12:00:00.000Z" },
				additionalCollections: current.additionalCollections.map(item => ({
					...item,
					capturedAt: "2026-08-26T12:00:00.000Z",
				})),
			},
		});

		expect(result.changed).toBeFalse();
		expect(result.profile.revision).toBe(1);
	});
});

describe("SessionManager Session Skills Profile integration", () => {
	test("initializes Profile as the fixed CustomEntry and recovers it from current branch", async () => {
		const manager = SessionManager.inMemory();
		const result = await manager.initializeSessionSkillsProfile(
			{ baseCollection: collection("base", ["base-a"]) },
			context(manager, 0),
		);
		if (!result.entryId) throw new Error("Expected Profile entry ID");

		expect(result.profile.revision).toBe(1);
		expect(result.activeLeafId).toBe(result.entryId);
		expect(manager.getEntries().at(-1)).toMatchObject({
			type: "custom",
			customType: SESSION_SKILLS_PROFILE_CUSTOM_TYPE,
			data: result.profile,
		});
		expect(manager.getSessionSkillsState()).toEqual({ activeLeafId: result.entryId, profile: result.profile });
	});

	test("appends a complete Profile for changes and does not append for no-op", async () => {
		const manager = SessionManager.inMemory();
		const initial = await manager.initializeSessionSkillsProfile(
			{ baseCollection: collection("base", ["base-a"]) },
			context(manager, 0),
		);
		const changed = await manager.updateSessionSkillsProfile(
			{ type: "disable-skill", skillId: "base-a" },
			{ expectedActiveLeafId: initial.activeLeafId, expectedRevision: 1 },
		);
		const entryCount = manager.getEntries().length;
		const noOp = await manager.updateSessionSkillsProfile(
			{ type: "disable-skill", skillId: "base-a" },
			{ expectedActiveLeafId: changed.activeLeafId, expectedRevision: 2 },
		);

		const latestEntry = manager.getEntries().at(-1);
		if (latestEntry?.type !== "custom") throw new Error("Expected Profile CustomEntry");
		expect(latestEntry.data).toEqual(changed.profile);
		expect(noOp.changed).toBeFalse();
		expect(noOp.entryId).toBeUndefined();
		expect(manager.getEntries()).toHaveLength(entryCount);
	});

	test("serializes concurrent mutations so only one client with the same version succeeds", async () => {
		const manager = SessionManager.inMemory();
		const initial = await manager.initializeSessionSkillsProfile(
			{ baseCollection: collection("base", ["a", "b"]) },
			context(manager, 0),
		);
		const sharedContext = { expectedActiveLeafId: initial.activeLeafId, expectedRevision: 1 };
		const results = await Promise.allSettled([
			manager.updateSessionSkillsProfile({ type: "disable-skill", skillId: "a" }, sharedContext),
			manager.updateSessionSkillsProfile({ type: "disable-skill", skillId: "b" }, sharedContext),
		]);

		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
		expect(manager.getSessionSkillsState().profile?.revision).toBe(2);
	});

	test("rejects a mutation when an ordinary entry changed active leaf", async () => {
		const manager = SessionManager.inMemory();
		const initial = await manager.initializeSessionSkillsProfile(
			{ baseCollection: collection("base", ["a"]) },
			context(manager, 0),
		);
		manager.appendCustomEntry("ordinary-state", {});

		await expect(
			manager.updateSessionSkillsProfile(
				{ type: "disable-skill", skillId: "a" },
				{ expectedActiveLeafId: initial.activeLeafId, expectedRevision: 1 },
			),
		).rejects.toMatchObject({ code: "stale_profile" });
	});

	test("inherits Profile at a branch point and isolates subsequent branch mutations", async () => {
		const manager = SessionManager.inMemory();
		const initial = await manager.initializeSessionSkillsProfile(
			{ baseCollection: collection("base", ["a", "b"]) },
			context(manager, 0),
		);
		const changed = await manager.updateSessionSkillsProfile(
			{ type: "disable-skill", skillId: "a" },
			{ expectedActiveLeafId: initial.activeLeafId, expectedRevision: 1 },
		);
		manager.branch(initial.entryId!);
		const branched = await manager.updateSessionSkillsProfile(
			{ type: "disable-skill", skillId: "b" },
			{ expectedActiveLeafId: initial.entryId!, expectedRevision: 1 },
		);

		expect(branched.profile.disabledSkillIds).toEqual(["b"]);
		manager.branch(changed.entryId!);
		expect(manager.getSessionSkillsState().profile?.disabledSkillIds).toEqual(["a"]);
	});

	test("materializes an otherwise empty persisted session and restores Profile after reopen", async () => {
		const storage = new MemorySessionStorage();
		const manager = SessionManager.create("/cwd", "/sessions", storage);
		await manager.initializeSessionSkillsProfile({ baseCollection: collection("base", ["a"]) }, context(manager, 0));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions", storage, { initialCwd: "/cwd" });
		expect(reopened.getSessionSkillsState().profile).toMatchObject({
			revision: 1,
			baseCollection: { collectionId: "base" },
		});
		await reopened.close();
	});
});
