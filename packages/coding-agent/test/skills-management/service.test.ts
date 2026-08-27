import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { Skill } from "../../src/extensibility/skills";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { createSkillId, type SkillCatalogCandidate, SkillCatalogRepository } from "../../src/skills-management/catalog";
import { SkillCollectionsRepository } from "../../src/skills-management/collections";
import { SkillManagementService } from "../../src/skills-management/service";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-skill-service-"));
	temporaryDirectories.push(directory);
	return directory;
}

function writeSkill(root: string, directoryName: string): string {
	const directory = path.join(root, directoryName);
	fs.mkdirSync(directory, { recursive: true });
	const filePath = path.join(directory, "SKILL.md");
	fs.writeFileSync(filePath, "---\nname: review\ndescription: Review code\n---\n\nReview this change.\n");
	return fs.realpathSync(filePath);
}

function candidate(filePath: string, sourceRoot: string): SkillCatalogCandidate {
	return {
		canonicalPath: filePath,
		discoveredPath: filePath,
		sourceRoot,
		providerId: "custom",
		level: "user",
		discoveryKind: "custom",
		providerPriority: 0,
		name: "review",
		description: "Review code",
		status: "available",
	};
}

function projectCandidate(filePath: string, sourceRoot: string, projectRoot: string): SkillCatalogCandidate {
	return {
		canonicalPath: filePath,
		discoveredPath: filePath,
		sourceRoot,
		providerId: "native",
		level: "project",
		projectRoot,
		projectDistance: 0,
		discoveryKind: "standard",
		providerPriority: 100,
		name: "review",
		description: "Review code",
		status: "available",
	};
}

async function createServiceFixture(): Promise<{
	root: string;
	skillRoot: string;
	skillPath: string;
	catalog: SkillCatalogRepository;
	collections: SkillCollectionsRepository;
	sessionManager: SessionManager;
	service: SkillManagementService;
	setBusy(busy: boolean): void;
	setPrepareFailure(error: Error | undefined): void;
}> {
	const root = temporaryDirectory();
	const skillRoot = path.join(root, "skills");
	const skillPath = writeSkill(skillRoot, "review");
	const catalog = new SkillCatalogRepository({ filePath: path.join(root, "skill-catalog.yml") });
	await catalog.commitRootScan({
		status: "success",
		providerId: "custom",
		sourceRoot: skillRoot,
		candidates: [candidate(skillPath, skillRoot)],
	});
	const collections = new SkillCollectionsRepository({ filePath: path.join(root, "skill-collections.yml") });
	const sessionManager = SessionManager.inMemory(root);
	const settings = Settings.isolated({ "skills.customDirectories": [skillRoot] });
	let busy = false;
	let prepareFailure: Error | undefined;
	const sessionStub = {
		settings,
		sessionManager,
		skills: [] as readonly Skill[],
		get isStreaming() {
			return busy;
		},
		get isCompacting() {
			return false;
		},
		applyResolvedSkills(): Promise<void> {
			return Promise.resolve();
		},
		prepareResolvedSkills(skills: readonly Skill[]): Promise<{ skills: readonly Skill[] }> {
			if (prepareFailure) return Promise.reject(prepareFailure);
			return Promise.resolve({ skills });
		},
		commitResolvedSkills(): void {},
	};
	return {
		root,
		skillRoot,
		skillPath,
		catalog,
		collections,
		sessionManager,
		service: new SkillManagementService(sessionStub as unknown as AgentSession, { catalog, collections }),
		setBusy(value: boolean): void {
			busy = value;
		},
		setPrepareFailure(error: Error | undefined): void {
			prepareFailure = error;
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("SkillManagementService", () => {
	test("materializes local-all, resolves same-name paths and atomically activates the alternative", async () => {
		const root = temporaryDirectory();
		const leftRoot = path.join(root, "left");
		const rightRoot = path.join(root, "right");
		const leftPath = writeSkill(leftRoot, "review");
		const rightPath = writeSkill(rightRoot, "review");
		const catalog = new SkillCatalogRepository({ filePath: path.join(root, "skill-catalog.yml") });
		await catalog.commitRootScans([
			{ status: "success", providerId: "custom", sourceRoot: leftRoot, candidates: [candidate(leftPath, leftRoot)] },
			{
				status: "success",
				providerId: "custom",
				sourceRoot: rightRoot,
				candidates: [candidate(rightPath, rightRoot)],
			},
		]);
		const collections = new SkillCollectionsRepository({ filePath: path.join(root, "skill-collections.yml") });
		const sessionManager = SessionManager.inMemory(root);
		const settings = Settings.isolated({ "skills.customDirectories": [leftRoot, rightRoot] });
		let appliedSkills: readonly Skill[] = [];
		const sessionStub = {
			settings,
			sessionManager,
			skills: [] as readonly Skill[],
			isStreaming: false,
			isCompacting: false,
			applyResolvedSkills(skills: readonly Skill[]): Promise<void> {
				appliedSkills = skills;
				return Promise.resolve();
			},
			prepareResolvedSkills(skills: readonly Skill[]): Promise<{ skills: readonly Skill[] }> {
				return Promise.resolve({ skills });
			},
			commitResolvedSkills(prepared: { skills: readonly Skill[] }): void {
				appliedSkills = prepared.skills;
			},
		};
		const service = new SkillManagementService(sessionStub as unknown as AgentSession, { catalog, collections });

		const initial = await service.getSessionSkills();
		expect(initial.profile.baseCollection?.collectionId).toBe("local-all");
		expect(initial.memberStates).toHaveLength(2);
		expect(initial.resolved.resolutions[0].candidateSkillIds).toHaveLength(2);
		const initialWinner = initial.resolved.resolutions[0].activeSkillId;
		const alternative = [createSkillId(leftPath), createSkillId(rightPath)].find(
			skillId => skillId !== initialWinner,
		);
		if (!alternative) throw new Error("Expected a same-name alternative Skill");

		const activated = await service.activateSessionSkill(alternative, {
			expectedActiveLeafId: initial.activeLeafId,
			expectedRevision: initial.profile.revision,
		});
		expect(activated.resolved.resolutions[0].activeSkillId).toBe(alternative);
		expect(activated.profile.disabledSkillIds).toContain(initialWinner);
		expect(activated.profile.addedSkillIds).toContain(alternative);
		expect(activated.profile.revision).toBe(2);
		expect(appliedSkills.map(skill => createSkillId(fs.realpathSync(skill.filePath)))).toEqual([alternative]);
	});

	test("keeps the previous Catalog state when a configured root cannot be scanned", async () => {
		const { skillRoot, skillPath, catalog, service } = await createServiceFixture();
		fs.rmSync(skillRoot, { recursive: true });
		fs.writeFileSync(skillRoot, "This path is no longer a directory.");

		await service.rescanCatalog({ refreshSession: false });

		const entry = (await catalog.getSnapshot()).entries.find(item => item.skillId === createSkillId(skillPath));
		expect(entry).toMatchObject({
			status: "available",
			canonicalPath: skillPath,
			sources: [{ providerId: "custom", sourceRoot: skillRoot }],
		});
	});

	test("refreshes workspace eligibility after the session cwd moves", async () => {
		const root = temporaryDirectory();
		const projectA = path.join(root, "project-a");
		const projectB = path.join(root, "project-b");
		const skillsRoot = path.join(projectA, ".omp", "skills");
		fs.mkdirSync(projectB, { recursive: true });
		const skillPath = writeSkill(skillsRoot, "review");
		const catalog = new SkillCatalogRepository({ filePath: path.join(root, "skill-catalog.yml") });
		await catalog.commitRootScan({
			status: "success",
			providerId: "native",
			sourceRoot: skillsRoot,
			candidates: [projectCandidate(skillPath, skillsRoot, projectA)],
		});
		const collections = new SkillCollectionsRepository({ filePath: path.join(root, "skill-collections.yml") });
		const sessionManager = SessionManager.inMemory(projectA);
		const settings = Settings.isolated({
			"skills.enabled": true,
			"skills.enableCodexUser": false,
			"skills.enableClaudeUser": false,
			"skills.enableClaudeProject": false,
			"skills.enablePiUser": false,
			"skills.enablePiProject": true,
		});
		let appliedSkills: readonly Skill[] = [];
		const sessionStub = {
			settings,
			sessionManager,
			skills: [] as readonly Skill[],
			isStreaming: false,
			isCompacting: false,
			applyResolvedSkills(skills: readonly Skill[]): Promise<void> {
				appliedSkills = skills;
				return Promise.resolve();
			},
			prepareResolvedSkills(skills: readonly Skill[]): Promise<{ skills: readonly Skill[] }> {
				return Promise.resolve({ skills });
			},
			commitResolvedSkills(prepared: { skills: readonly Skill[] }): void {
				appliedSkills = prepared.skills;
			},
		};
		const service = new SkillManagementService(sessionStub as unknown as AgentSession, { catalog, collections });
		const initial = await service.getSessionSkills();

		expect(initial.memberStates[0]?.eligibility).toBe("eligible");
		await sessionManager.moveTo(projectB);
		const moved = await service.refreshSessionSkills({ rescanCatalog: false });

		expect(moved.memberStates[0]?.eligibility).toBe("out_of_scope");
		expect(moved.memberStates[0]?.reasons).toContain("out_of_scope");
		expect(appliedSkills).toEqual([]);
	});

	test("rejects sync when Collections change while selected snapshots are being read", async () => {
		const { collections, sessionManager, service } = await createServiceFixture();
		const initial = await service.getSessionSkills();
		const preview = await service.previewSessionSync();
		const snapshotRead = Promise.withResolvers<void>();
		const releaseSnapshot = Promise.withResolvers<void>();
		const getCollection = collections.get.bind(collections);
		vi.spyOn(collections, "get").mockImplementation(async (...args) => {
			const result = await getCollection(...args);
			snapshotRead.resolve();
			await releaseSnapshot.promise;
			return result;
		});

		const syncing = service.syncSessionSkills(
			{
				expectedProfileRevision: preview.profileRevision,
				expectedCollectionsRevision: preview.collectionsRevision,
				expectedCatalogRevision: preview.catalogRevision,
			},
			{ expectedActiveLeafId: initial.activeLeafId, expectedRevision: initial.profile.revision },
		);
		await snapshotRead.promise;
		await collections.create({ name: "Concurrent collection" }, { expectedRevision: preview.collectionsRevision });
		releaseSnapshot.resolve();

		await expect(syncing).rejects.toMatchObject({ code: "stale_sync_preview" });
		expect(sessionManager.getSessionSkillsState().profile?.revision).toBe(initial.profile.revision);
	});

	test("rejects sync when Catalog changes while selected snapshots are being read", async () => {
		const { skillRoot, skillPath, catalog, collections, sessionManager, service } = await createServiceFixture();
		const initial = await service.getSessionSkills();
		const preview = await service.previewSessionSync();
		const snapshotRead = Promise.withResolvers<void>();
		const releaseSnapshot = Promise.withResolvers<void>();
		const getCollection = collections.get.bind(collections);
		vi.spyOn(collections, "get").mockImplementation(async (...args) => {
			const result = await getCollection(...args);
			snapshotRead.resolve();
			await releaseSnapshot.promise;
			return result;
		});

		const syncing = service.syncSessionSkills(
			{
				expectedProfileRevision: preview.profileRevision,
				expectedCollectionsRevision: preview.collectionsRevision,
				expectedCatalogRevision: preview.catalogRevision,
			},
			{ expectedActiveLeafId: initial.activeLeafId, expectedRevision: initial.profile.revision },
		);
		await snapshotRead.promise;
		await catalog.commitRootScan({
			status: "success",
			providerId: "custom",
			sourceRoot: skillRoot,
			candidates: [{ ...candidate(skillPath, skillRoot), description: "Changed concurrently" }],
		});
		releaseSnapshot.resolve();

		await expect(syncing).rejects.toMatchObject({ code: "stale_sync_preview" });
		expect(sessionManager.getSessionSkillsState().profile?.revision).toBe(initial.profile.revision);
	});

	test("does not append a Profile when the session becomes busy during resolution", async () => {
		const { catalog, sessionManager, service, setBusy } = await createServiceFixture();
		const initial = await service.getSessionSkills();
		const skillId = initial.memberStates[0]?.skillId;
		if (!skillId) throw new Error("Expected a Skill in the initial Profile");
		const catalogRead = Promise.withResolvers<void>();
		const releaseCatalog = Promise.withResolvers<void>();
		const getSnapshot = catalog.getSnapshot.bind(catalog);
		vi.spyOn(catalog, "getSnapshot").mockImplementation(async () => {
			const result = await getSnapshot();
			catalogRead.resolve();
			await releaseCatalog.promise;
			return result;
		});

		const mutation = service.disableSessionSkill(skillId, {
			expectedActiveLeafId: initial.activeLeafId,
			expectedRevision: initial.profile.revision,
		});
		await catalogRead.promise;
		setBusy(true);
		releaseCatalog.resolve();

		await expect(mutation).rejects.toMatchObject({ code: "session_busy" });
		expect(sessionManager.getSessionSkillsState().profile?.revision).toBe(initial.profile.revision);
	});

	test("does not append a Profile when candidate runtime preparation fails", async () => {
		const { sessionManager, service, setPrepareFailure } = await createServiceFixture();
		const initial = await service.getSessionSkills();
		const skillId = initial.memberStates[0]?.skillId;
		if (!skillId) throw new Error("Expected a Skill in the initial Profile");
		const entryCount = sessionManager.getEntries().length;
		setPrepareFailure(new Error("candidate prompt failed"));

		await expect(
			service.disableSessionSkill(skillId, {
				expectedActiveLeafId: initial.activeLeafId,
				expectedRevision: initial.profile.revision,
			}),
		).rejects.toThrow("candidate prompt failed");

		expect(sessionManager.getEntries()).toHaveLength(entryCount);
		expect(sessionManager.getSessionSkillsState().profile?.revision).toBe(initial.profile.revision);
	});

	test("keeps an explicitly empty collection scope across refresh, rescan, and sync", async () => {
		const { service } = await createServiceFixture();
		const initial = await service.getSessionSkills();
		const baseCollectionId = initial.profile.baseCollection?.collectionId;
		if (!baseCollectionId) throw new Error("Expected the new session to inherit a default collection");

		const removed = await service.removeCollection(baseCollectionId, {
			expectedActiveLeafId: initial.activeLeafId,
			expectedRevision: initial.profile.revision,
		});
		expect(removed.profile.baseCollection).toBeNull();
		expect(removed.memberStates).toEqual([]);

		const refreshed = await service.refreshSessionSkills({ rescanCatalog: false });
		expect(refreshed.profile.baseCollection).toBeNull();
		expect(refreshed.memberStates).toEqual([]);

		await service.rescanCatalog();
		const rescanned = await service.getSessionSkills();
		expect(rescanned.profile.baseCollection).toBeNull();
		expect(rescanned.memberStates).toEqual([]);

		const preview = await service.previewSessionSync();
		expect(preview).toMatchObject({ addedSkillIds: [], removedSkillIds: [], winnerChanges: [] });
		const synced = await service.syncSessionSkills(
			{
				expectedProfileRevision: preview.profileRevision,
				expectedCollectionsRevision: preview.collectionsRevision,
				expectedCatalogRevision: preview.catalogRevision,
			},
			{ expectedActiveLeafId: rescanned.activeLeafId, expectedRevision: rescanned.profile.revision },
		);
		expect(synced.profile.baseCollection).toBeNull();
		expect(synced.profile.revision).toBe(removed.profile.revision);
		expect(synced.memberStates).toEqual([]);
	});

	test("keeps a manually added Skill when its collection is removed", async () => {
		const { service } = await createServiceFixture();
		const initial = await service.getSessionSkills();
		const baseCollectionId = initial.profile.baseCollection?.collectionId;
		const skillId = initial.memberStates[0]?.skillId;
		if (!baseCollectionId || !skillId) throw new Error("Expected the default collection to contain a Skill");

		const added = await service.addSessionSkill(skillId, {
			expectedActiveLeafId: initial.activeLeafId,
			expectedRevision: initial.profile.revision,
		});
		const removed = await service.removeCollection(baseCollectionId, {
			expectedActiveLeafId: added.activeLeafId,
			expectedRevision: added.profile.revision,
		});

		expect(removed.profile.baseCollection).toBeNull();
		expect(removed.profile.addedSkillIds).toEqual([skillId]);
		expect(removed.memberStates.map(member => member.skillId)).toEqual([skillId]);
	});

	test("uses a changed global default only for subsequently initialized sessions", async () => {
		const { root, skillRoot, catalog, collections, service } = await createServiceFixture();
		const existing = await service.getSessionSkills();
		const collectionState = await collections.getSnapshot();
		const created = await collections.create(
			{ name: "No default Skills", skillIds: [] },
			{ expectedRevision: collectionState.state.revision },
		);
		const collectionId = created.collection?.collectionId;
		if (!collectionId) throw new Error("Expected a persisted collection");
		await service.setDefaultCollection(collectionId, { expectedRevision: created.state.revision });

		const unchanged = await service.getSessionSkills();
		expect(unchanged.profile.baseCollection?.collectionId).toBe(existing.profile.baseCollection?.collectionId);

		const nextSessionManager = SessionManager.inMemory(root);
		const nextSession = {
			settings: Settings.isolated({ "skills.customDirectories": [skillRoot] }),
			sessionManager: nextSessionManager,
			skills: [] as readonly Skill[],
			isStreaming: false,
			isCompacting: false,
			applyResolvedSkills(): Promise<void> {
				return Promise.resolve();
			},
			prepareResolvedSkills(skills: readonly Skill[]): Promise<{ skills: readonly Skill[] }> {
				return Promise.resolve({ skills });
			},
			commitResolvedSkills(): void {},
		};
		const nextService = new SkillManagementService(nextSession as unknown as AgentSession, { catalog, collections });

		const initialized = await nextService.getSessionSkills();
		expect(initialized.profile.baseCollection?.collectionId).toBe(collectionId);
		expect(initialized.memberStates).toEqual([]);
	});
});
