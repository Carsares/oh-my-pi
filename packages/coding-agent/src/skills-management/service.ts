import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	isValidManagedSkillName,
	MANAGED_SKILLS_PROVIDER_ID,
	sanitizeManagedDescription,
} from "../autolearn/managed-skills";
import { getCapabilityInfo, reset as resetCapabilities } from "../capability";
import { type Skill as CapabilitySkill, skillCapability } from "../capability/skill";
import type { SourceMeta } from "../capability/types";
import type { SkillsSettings } from "../config/settings";
import { loadCapability } from "../discovery";
import { compareSkillOrder, scanSkillsFromDir } from "../discovery/helpers";
import type { Skill } from "../extensibility/skills";
import type { AgentSession } from "../session/agent-session";
import { expandTilde } from "../tools/path-utils";
import {
	createSkillId,
	discoverSkillCatalogCandidates,
	type SkillCatalogEntry,
	SkillCatalogRepository,
	type SkillCatalogState,
	type SkillRootScanResult,
	type SkillSourceRef,
} from "./catalog";
import {
	type CollectionMutationContext,
	type CollectionMutationResult,
	type CreateCollectionParams,
	type GlobalSkillCollectionsState,
	type LocalAllSkillCollection,
	type SkillCollection,
	type SkillCollectionsListResult,
	SkillCollectionsRepository,
	type UpdateCollectionParams,
} from "./collections";
import { SkillManagementError } from "./errors";
import { resolveEffectiveSkillSource, resolveSkillCandidates, type SkillResolutionCandidate } from "./resolver";
import {
	type CollectionSnapshot,
	cloneSessionSkillsProfile,
	reduceSessionSkillsProfile,
	resolveSessionSkillIds,
	type SessionSkillsMutationContext,
	type SessionSkillsProfile,
	type SessionSkillsProfileMutation,
} from "./session";
import type {
	AppliedSessionSkills,
	ResolvedSessionSkills,
	SessionSkillsStateResult,
	SessionSkillsSyncPreview,
	SessionSkillsSyncRevisions,
	SkillCatalogEntryState,
	SkillCatalogListResult,
	SkillCatalogQuery,
	SkillDiagnostic,
	SkillEligibility,
	SkillMemberState,
} from "./types";

const LEGACY_CURRENT_COLLECTION_ID = "legacy-current";

function rootKey(value: Pick<SkillSourceRef, "providerId" | "sourceRoot">): string {
	return `${value.providerId}\0${value.sourceRoot}`;
}

function sourceInWorkspace(source: SkillSourceRef, cwd: string): boolean {
	if (source.level === "user") return true;
	if (!source.projectRoot) return source.discoveredPath.startsWith(`${path.resolve(cwd)}${path.sep}`);
	const relative = path.relative(source.projectRoot, cwd);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasMessages(session: AgentSession): boolean {
	return session.sessionManager
		.getEntries()
		.some(entry => entry.type === "message" || entry.type === "custom_message");
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function memberSkillIds(profile: SessionSkillsProfile): string[] {
	return unique([
		...profile.baseCollection.skillIds,
		...profile.additionalCollections.flatMap(collection => collection.skillIds),
		...profile.addedSkillIds,
	]);
}

function globMatches(name: string, patterns: readonly string[]): boolean {
	return patterns.some(pattern => new Bun.Glob(pattern).match(name));
}

/** Coordinates Catalog, Collections, branch-scoped Profile and the live AgentSession runtime. */
export class SkillManagementService {
	readonly #session: AgentSession;
	readonly #catalog: SkillCatalogRepository;
	readonly #collections: SkillCollectionsRepository;
	#cwd: string;
	#sessionManagerCwd: string;

	constructor(
		session: AgentSession,
		options: {
			catalog?: SkillCatalogRepository;
			collections?: SkillCollectionsRepository;
			cwd?: string;
			agentDir?: string;
		} = {},
	) {
		this.#session = session;
		this.#sessionManagerCwd = path.resolve(session.sessionManager.getCwd());
		this.#cwd = path.resolve(options.cwd ?? this.#sessionManagerCwd);
		const agentDir = options.agentDir ?? session.settings.getAgentDir();
		this.#catalog = options.catalog ?? new SkillCatalogRepository({ agentDir });
		this.#collections = options.collections ?? new SkillCollectionsRepository({ agentDir });
	}

	async initialize(): Promise<SessionSkillsStateResult> {
		await this.rescanCatalog();
		await this.#ensureProfile();
		return await this.refreshSessionSkills({ rescanCatalog: false });
	}

	async listCatalog(query: SkillCatalogQuery = {}): Promise<SkillCatalogListResult> {
		const catalog = await this.#catalog.getSnapshot();
		let entries = catalog.entries.map(entry => this.#entryState(entry));
		if (query.name) {
			const normalized = query.name.toLowerCase();
			entries = entries.filter(entry =>
				(entry.name ?? entry.lastKnownName ?? "").toLowerCase().includes(normalized),
			);
		}
		if (query.providerId)
			entries = entries.filter(entry => entry.sources.some(source => source.providerId === query.providerId));
		if (query.status) entries = entries.filter(entry => entry.status === query.status);
		return { revision: catalog.revision, entries };
	}

	async getCatalogEntry(skillId: string): Promise<SkillCatalogEntryState> {
		const entry = (await this.#catalog.getSnapshot()).entries.find(candidate => candidate.skillId === skillId);
		if (!entry) throw new SkillManagementError("skill_not_found", `Skill does not exist: ${skillId}`);
		return this.#entryState(entry);
	}

	async rescanCatalog(options: { refreshSession?: boolean } = {}): Promise<SkillCatalogListResult> {
		this.#refreshCwdFromSession();
		const sessionState = this.#session.sessionManager.getSessionSkillsState();
		if (sessionState.profile) this.#assertIdle();
		// The Desktop host installs local directories by updating config.yml from
		// another process. Reload that persisted layer before discovery so a rescan
		// can observe the install without restarting OMP.
		await this.#session.settings.reloadFromDisk();
		resetCapabilities();
		const settings = this.#session.settings.getGroup("skills");
		const discovery = await discoverSkillCatalogCandidates(this.#cwd, settings);
		const scansByRoot = new Map<string, SkillRootScanResult>(discovery.rootScans.map(scan => [rootKey(scan), scan]));
		const providerErrors = new Map(discovery.providerErrors.map(error => [error.providerId, error.error]));

		const current = await this.#catalog.getSnapshot();
		const providerEnabled = new Map(
			(getCapabilityInfo(skillCapability.id)?.providers ?? []).map(provider => [provider.id, provider.enabled]),
		);
		const configuredCustomRoots = new Set(
			(settings.customDirectories ?? []).map(directory => path.resolve(expandTilde(directory))),
		);
		const currentRoots = new Map<string, SkillSourceRef>();
		for (const entry of current.entries) {
			for (const source of entry.sources) currentRoots.set(rootKey(source), source);
		}

		for (const [key, source] of currentRoots) {
			if (scansByRoot.has(key) || !sourceInWorkspace(source, this.#cwd)) continue;
			if (source.providerId === "custom" && !configuredCustomRoots.has(source.sourceRoot)) continue;
			if (source.providerId !== "custom" && providerEnabled.get(source.providerId) === false) continue;
			const providerError = providerErrors.get(source.providerId);
			if (providerError) {
				scansByRoot.set(key, {
					status: "failed",
					providerId: source.providerId,
					sourceRoot: source.sourceRoot,
					error: providerError,
				});
				continue;
			}
			try {
				await fs.access(source.sourceRoot);
				scansByRoot.set(key, {
					status: "success",
					providerId: source.providerId,
					sourceRoot: source.sourceRoot,
					candidates: [],
				});
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				scansByRoot.set(
					key,
					code === "ENOENT"
						? { status: "success", providerId: source.providerId, sourceRoot: source.sourceRoot, candidates: [] }
						: {
								status: "failed",
								providerId: source.providerId,
								sourceRoot: source.sourceRoot,
								error: String(error),
							},
				);
			}
		}

		for (const [key, scan] of scansByRoot) {
			if (scan.status !== "success") continue;
			const discoveredPaths = new Set(scan.candidates.map(candidate => candidate.canonicalPath));
			for (const entry of current.entries) {
				const matchingSource = entry.sources.find(source => rootKey(source) === key);
				if (!matchingSource || discoveredPaths.has(entry.canonicalPath)) continue;
				try {
					await fs.access(entry.canonicalPath);
					scan.candidates.push({
						...matchingSource,
						canonicalPath: entry.canonicalPath,
						name: entry.lastKnownName ?? entry.name,
						description: entry.lastKnownDescription ?? entry.description,
						status: "invalid",
						parseError: "SKILL.md could not be parsed by its registered provider",
					});
				} catch {}
			}
		}

		const catalog = await this.#catalog.commitRootScans([...scansByRoot.values()]);
		if (sessionState.profile && options.refreshSession !== false) {
			const applied = await this.#resolveProfile(sessionState.profile, catalog);
			await this.#session.applyResolvedSkills(applied.activeSkills, []);
		}
		return await this.listCatalog();
	}

	async listCollections(): Promise<SkillCollectionsListResult> {
		return await this.#collections.list(await this.#eligibleSkillIds());
	}

	async getCollection(collectionId: string): Promise<{
		state: GlobalSkillCollectionsState;
		collection: SkillCollection | LocalAllSkillCollection;
	}> {
		return await this.#collections.get(collectionId, await this.#eligibleSkillIds());
	}

	async createCollection(
		params: CreateCollectionParams,
		context: CollectionMutationContext,
	): Promise<CollectionMutationResult> {
		return await this.#collections.create(params, context);
	}

	async updateCollection(
		params: UpdateCollectionParams,
		context: CollectionMutationContext,
	): Promise<CollectionMutationResult> {
		return await this.#collections.update(params, context);
	}

	async deleteCollection(collectionId: string, context: CollectionMutationContext): Promise<CollectionMutationResult> {
		return await this.#collections.delete(collectionId, context);
	}

	async setDefaultCollection(
		collectionId: string,
		context: CollectionMutationContext,
	): Promise<CollectionMutationResult> {
		return await this.#collections.setDefault(collectionId, context);
	}

	async getSessionSkills(): Promise<SessionSkillsStateResult> {
		await this.#ensureProfile();
		const state = this.#session.sessionManager.getSessionSkillsState();
		if (!state.profile) throw new SkillManagementError("profile_invalid", "Session Skills Profile is missing");
		return await this.#buildSessionState(state.profile, state.activeLeafId);
	}

	async setBaseCollection(
		collectionId: string,
		context: SessionSkillsMutationContext,
	): Promise<SessionSkillsStateResult> {
		return await this.#mutateProfile(
			{ type: "set-base-collection", collection: await this.#collectionSnapshot(collectionId) },
			context,
		);
	}

	async addCollection(collectionId: string, context: SessionSkillsMutationContext): Promise<SessionSkillsStateResult> {
		return await this.#mutateProfile(
			{ type: "add-collection", collection: await this.#collectionSnapshot(collectionId) },
			context,
		);
	}

	async removeCollection(
		collectionId: string,
		context: SessionSkillsMutationContext,
	): Promise<SessionSkillsStateResult> {
		return await this.#mutateProfile({ type: "remove-collection", collectionId }, context);
	}

	async addSessionSkill(skillId: string, context: SessionSkillsMutationContext): Promise<SessionSkillsStateResult> {
		await this.#requireAvailableSkill(skillId);
		return await this.#mutateProfile({ type: "add-skill", skillId }, context);
	}

	async disableSessionSkill(
		skillId: string,
		context: SessionSkillsMutationContext,
	): Promise<SessionSkillsStateResult> {
		return await this.#mutateProfile({ type: "disable-skill", skillId }, context);
	}

	async restoreSessionSkill(
		skillId: string,
		context: SessionSkillsMutationContext,
	): Promise<SessionSkillsStateResult> {
		return await this.#mutateProfile({ type: "restore-skill", skillId }, context);
	}

	async activateSessionSkill(
		skillId: string,
		context: SessionSkillsMutationContext,
	): Promise<SessionSkillsStateResult> {
		const target = await this.#requireAvailableSkill(skillId);
		const profile = this.#session.sessionManager.getSessionSkillsState().profile;
		if (!profile) throw new SkillManagementError("profile_invalid", "Session Skills Profile is missing");
		const catalog = await this.#catalog.getSnapshot();
		const conflictingSkillIds = memberSkillIds(profile).filter(candidateId => {
			const candidate = catalog.entries.find(entry => entry.skillId === candidateId);
			return candidateId !== skillId && candidate?.name === target.name;
		});
		return await this.#mutateProfile({ type: "activate-skill", skillId, conflictingSkillIds }, context);
	}

	async previewSessionSync(): Promise<SessionSkillsSyncPreview> {
		const current = await this.getSessionSkills();
		const snapshots = await this.#syncedSnapshots(current.profile);
		const reduced = reduceSessionSkillsProfile(current.profile, { type: "sync", snapshots });
		const next = await this.#resolveProfile(reduced.profile, await this.#catalog.getSnapshot());
		const previousByName = new Map(
			current.resolved.resolutions.map(resolution => [resolution.name, resolution.activeSkillId]),
		);
		const nextByName = new Map(
			next.resolved.resolutions.map(resolution => [resolution.name, resolution.activeSkillId]),
		);
		const names = new Set([...previousByName.keys(), ...nextByName.keys()]);
		const winnerChanges = [...names]
			.filter(name => previousByName.get(name) !== nextByName.get(name))
			.map(name => ({ name, previousSkillId: previousByName.get(name), nextSkillId: nextByName.get(name) }));
		return {
			profileRevision: current.profile.revision,
			collectionsRevision: current.collectionsRevision,
			catalogRevision: current.catalogRevision,
			addedSkillIds: reduced.diff.addedSkillIds,
			removedSkillIds: reduced.diff.removedSkillIds,
			newConflictNames: next.resolved.resolutions
				.filter(resolution => resolution.shadowedSkillIds.length > 0)
				.map(resolution => resolution.name),
			winnerChanges,
		};
	}

	async syncSessionSkills(
		revisions: SessionSkillsSyncRevisions,
		context: SessionSkillsMutationContext,
	): Promise<SessionSkillsStateResult> {
		const current = await this.getSessionSkills();
		if (
			current.profile.revision !== revisions.expectedProfileRevision ||
			current.collectionsRevision !== revisions.expectedCollectionsRevision ||
			current.catalogRevision !== revisions.expectedCatalogRevision
		) {
			throw new SkillManagementError("stale_sync_preview", "Session Skills sync preview is stale", current);
		}
		return await this.#mutateProfile(
			{ type: "sync", snapshots: await this.#syncedSnapshots(current.profile) },
			context,
			revisions,
		);
	}

	async refreshSessionSkills(options: { rescanCatalog?: boolean } = {}): Promise<SessionSkillsStateResult> {
		this.#refreshCwdFromSession();
		await this.#ensureProfile();
		if (options.rescanCatalog !== false) await this.rescanCatalog({ refreshSession: false });
		const state = this.#session.sessionManager.getSessionSkillsState();
		if (!state.profile) throw new SkillManagementError("profile_invalid", "Session Skills Profile is missing");
		const applied = await this.#resolveProfile(state.profile, await this.#catalog.getSnapshot());
		await this.#session.applyResolvedSkills(applied.activeSkills, []);
		return await this.#buildSessionState(state.profile, state.activeLeafId, applied);
	}

	/** Preserve manage_skill hot registration without making ordinary rescans change frozen membership. */
	async handleManagedSkillChange(action: "create" | "update" | "delete", name: string): Promise<void> {
		// A create is applied by the Profile mutation below; refreshing during the
		// scan as well would publish the same command metadata change twice.
		await this.rescanCatalog({ refreshSession: action !== "create" });
		if (action !== "create") return;
		const catalog = await this.#catalog.getSnapshot();
		const entry = catalog.entries.find(
			candidate =>
				candidate.status === "available" &&
				candidate.name === name &&
				candidate.sources.some(source => source.discoveryKind === "managed"),
		);
		if (!entry) return;
		const state = this.#session.sessionManager.getSessionSkillsState();
		if (!state.profile || memberSkillIds(state.profile).includes(entry.skillId)) return;
		await this.addSessionSkill(entry.skillId, {
			expectedActiveLeafId: state.activeLeafId,
			expectedRevision: state.profile.revision,
		});
	}

	async #ensureProfile(): Promise<void> {
		const current = this.#session.sessionManager.getSessionSkillsState();
		if (current.profile) return;
		const baseCollection = hasMessages(this.#session)
			? await this.#legacySnapshot()
			: await this.#defaultCollectionSnapshot();
		await this.#session.sessionManager.initializeSessionSkillsProfile(
			{ baseCollection },
			{ expectedActiveLeafId: current.activeLeafId, expectedRevision: 0 },
		);
	}

	async #legacySnapshot(): Promise<CollectionSnapshot> {
		const catalog = await this.#catalog.getSnapshot();
		const ids: string[] = [];
		for (const skill of this.#session.skills) {
			try {
				const skillId = createSkillId(await fs.realpath(skill.filePath));
				if (catalog.entries.some(entry => entry.skillId === skillId)) ids.push(skillId);
			} catch {}
		}
		return {
			collectionId: LEGACY_CURRENT_COLLECTION_ID,
			collectionName: "Skills active at first migration",
			skillIds: unique(ids),
			capturedAt: new Date().toISOString(),
		};
	}

	async #defaultCollectionSnapshot(): Promise<CollectionSnapshot> {
		const collections = await this.#collections.getSnapshot();
		return await this.#collectionSnapshot(collections.state.defaultCollectionId);
	}

	async #collectionSnapshot(collectionId: string): Promise<CollectionSnapshot> {
		const result = await this.#collections.get(collectionId, await this.#eligibleSkillIds());
		return {
			collectionId: result.collection.collectionId,
			collectionName: result.collection.name,
			...("virtual" in result.collection ? {} : { sourceCollectionRevision: result.collection.revision }),
			skillIds: [...result.collection.skillIds],
			capturedAt: new Date().toISOString(),
		};
	}

	async #syncedSnapshots(profile: SessionSkillsProfile): Promise<{
		baseCollection: CollectionSnapshot;
		additionalCollections: CollectionSnapshot[];
	}> {
		try {
			return {
				baseCollection: await this.#collectionSnapshot(profile.baseCollection.collectionId),
				additionalCollections: await Promise.all(
					profile.additionalCollections.map(collection => this.#collectionSnapshot(collection.collectionId)),
				),
			};
		} catch (error) {
			if (error instanceof Error) throw error;
			throw new SkillManagementError("collection_not_found", "A selected Skill Collection no longer exists");
		}
	}

	async #mutateProfile(
		mutation: SessionSkillsProfileMutation,
		context: SessionSkillsMutationContext,
		syncRevisions?: SessionSkillsSyncRevisions,
	): Promise<SessionSkillsStateResult> {
		this.#assertIdle();
		if (syncRevisions) await this.#assertSyncRevisions(syncRevisions);
		const current = this.#session.sessionManager.getSessionSkillsState();
		if (!current.profile) throw new SkillManagementError("profile_invalid", "Session Skills Profile is missing");
		if (
			current.activeLeafId !== context.expectedActiveLeafId ||
			current.profile.revision !== context.expectedRevision
		) {
			throw new SkillManagementError("stale_profile", "Session Skills Profile has changed", current);
		}
		const reduced = reduceSessionSkillsProfile(current.profile, mutation);
		const catalog = await this.#catalog.getSnapshot();
		const prepared = await this.#resolveProfile(reduced.profile, catalog);
		const preparedRuntime = reduced.changed
			? await this.#session.prepareResolvedSkills(prepared.activeSkills, [])
			: undefined;
		if (syncRevisions) await this.#assertSyncRevisions(syncRevisions);
		const result = await this.#session.sessionManager.updateSessionSkillsProfile(mutation, context, () =>
			this.#assertIdle(),
		);
		if (result.changed && preparedRuntime) this.#session.commitResolvedSkills(preparedRuntime);
		return await this.#buildSessionState(result.profile, result.activeLeafId, prepared);
	}

	async #assertSyncRevisions(expected: SessionSkillsSyncRevisions): Promise<void> {
		const sessionState = this.#session.sessionManager.getSessionSkillsState();
		const [catalog, collections] = await Promise.all([this.#catalog.getSnapshot(), this.#collections.getSnapshot()]);
		if (
			sessionState.profile?.revision === expected.expectedProfileRevision &&
			collections.state.revision === expected.expectedCollectionsRevision &&
			catalog.revision === expected.expectedCatalogRevision
		) {
			return;
		}
		const current = sessionState.profile
			? await this.#buildSessionState(sessionState.profile, sessionState.activeLeafId)
			: sessionState;
		throw new SkillManagementError("stale_sync_preview", "Session Skills sync preview is stale", current);
	}

	#assertIdle(): void {
		if (this.#session.isStreaming || this.#session.isCompacting) {
			throw new SkillManagementError("session_busy", "Session Skills cannot change while the session is busy");
		}
	}

	#refreshCwdFromSession(): void {
		const current = path.resolve(this.#session.sessionManager.getCwd());
		if (current === this.#sessionManagerCwd) return;
		this.#sessionManagerCwd = current;
		this.#cwd = current;
	}

	async #requireAvailableSkill(skillId: string): Promise<SkillCatalogEntry> {
		const entry = (await this.#catalog.getSnapshot()).entries.find(candidate => candidate.skillId === skillId);
		if (!entry) throw new SkillManagementError("skill_not_found", `Skill does not exist: ${skillId}`);
		if (entry.status !== "available") {
			throw new SkillManagementError("skill_unavailable", `Skill is not available: ${skillId}`);
		}
		return entry;
	}

	async #eligibleSkillIds(): Promise<string[]> {
		const catalog = await this.#catalog.getSnapshot();
		return catalog.entries
			.filter(entry => this.#entryState(entry).eligibility === "eligible")
			.map(entry => entry.skillId);
	}

	#entryState(entry: SkillCatalogEntry): SkillCatalogEntryState {
		const reasons: string[] = [];
		if (entry.status === "missing") reasons.push("skill_missing");
		if (entry.status === "invalid") reasons.push("skill_invalid");
		const workspaceSources = entry.sources.filter(source => sourceInWorkspace(source, this.#cwd));
		if (workspaceSources.length === 0) reasons.push("out_of_scope");
		const settings = this.#session.settings.getGroup("skills");
		const enabledSources = workspaceSources.filter(source => this.#sourceEnabled(source, settings));
		if (workspaceSources.length > 0 && enabledSources.length === 0) reasons.push("provider_disabled");
		const name = entry.name ?? entry.lastKnownName;
		if (name && globMatches(name, settings.ignoredSkills ?? [])) reasons.push("ignored_by_name_filter");
		if (name && (settings.includeSkills?.length ?? 0) > 0 && !globMatches(name, settings.includeSkills ?? [])) {
			reasons.push("not_included_by_name_filter");
		}
		if ((this.#session.settings.get("disabledExtensions") ?? []).includes(`skill:${name}`)) {
			reasons.push("blocked_by_legacy_name_filter");
		}
		const effectiveSource = resolveEffectiveSkillSource(enabledSources);
		let eligibility: SkillEligibility = "eligible";
		if (workspaceSources.length === 0) eligibility = "out_of_scope";
		else if (entry.status !== "available" || !effectiveSource || reasons.some(reason => reason.includes("filter"))) {
			eligibility = "blocked";
		}
		return { ...structuredClone(entry), eligibility, ...(effectiveSource ? { effectiveSource } : {}), reasons };
	}

	#sourceEnabled(source: SkillSourceRef, settings: SkillsSettings): boolean {
		const provider = getCapabilityInfo(skillCapability.id)?.providers.find(
			candidate => candidate.id === source.providerId,
		);
		if (provider?.enabled === false) return false;
		if (source.discoveryKind === "custom" || source.discoveryKind === "managed") return settings.enabled !== false;
		if (settings.enabled === false) return false;
		if (source.providerId === "codex" && source.level === "user") return settings.enableCodexUser !== false;
		if (source.providerId === "claude" && source.level === "user") return settings.enableClaudeUser !== false;
		if (source.providerId === "claude" && source.level === "project") return settings.enableClaudeProject !== false;
		if (source.providerId === "native" && source.level === "user") return settings.enablePiUser !== false;
		if (source.providerId === "native" && source.level === "project") return settings.enablePiProject !== false;
		if (source.providerId === "agents" && source.level === "user") return settings.enableAgentsUser !== false;
		if (source.providerId === "agents" && source.level === "project") return settings.enableAgentsProject !== false;
		return (
			settings.enableCodexUser !== false ||
			settings.enableClaudeUser !== false ||
			settings.enableClaudeProject !== false ||
			settings.enablePiUser !== false ||
			settings.enablePiProject !== false
		);
	}

	async #buildSessionState(
		profile: SessionSkillsProfile,
		activeLeafId: string | null,
		applied?: AppliedSessionSkills,
	): Promise<SessionSkillsStateResult> {
		const catalog = await this.#catalog.getSnapshot();
		const collections = await this.#collections.getSnapshot();
		const resolution = applied ?? (await this.#resolveProfile(profile, catalog));
		const active = new Set(resolution.resolved.activeSkillIds);
		const shadowed = new Set(resolution.resolved.resolutions.flatMap(item => item.shadowedSkillIds));
		const disabled = new Set(profile.disabledSkillIds);
		const members = memberSkillIds(profile);
		const memberStates: SkillMemberState[] = members.map(skillId => {
			const entry = catalog.entries.find(candidate => candidate.skillId === skillId);
			const state = entry ? this.#entryState(entry) : undefined;
			return {
				skillId,
				included: true,
				availability: entry?.status ?? "missing",
				eligibility: state?.eligibility ?? "out_of_scope",
				runtimeStatus: disabled.has(skillId)
					? "disabled"
					: active.has(skillId)
						? "active"
						: shadowed.has(skillId)
							? "shadowed"
							: "inactive",
				reasons: state?.reasons ?? ["skill_not_found"],
				...(entry ? { entry: structuredClone(entry) } : {}),
			};
		});
		return {
			activeLeafId,
			profile: cloneSessionSkillsProfile(profile),
			catalogRevision: catalog.revision,
			collectionsRevision: collections.state.revision,
			resolved: resolution.resolved,
			memberStates,
		};
	}

	async #resolveProfile(profile: SessionSkillsProfile, catalog: SkillCatalogState): Promise<AppliedSessionSkills> {
		const diagnostics: SkillDiagnostic[] = [];
		const candidates: SkillResolutionCandidate[] = [];
		const runtimeSkills = await this.#loadRuntimeSkills();
		for (const skillId of resolveSessionSkillIds(profile)) {
			const entry = catalog.entries.find(candidate => candidate.skillId === skillId);
			if (!entry) {
				diagnostics.push({ skillId, code: "skill_not_found", reason: "Profile references an unknown Skill" });
				continue;
			}
			const state = this.#entryState(entry);
			if (
				entry.status !== "available" ||
				state.eligibility !== "eligible" ||
				!entry.name ||
				!state.effectiveSource
			) {
				diagnostics.push({
					skillId,
					code: entry.status !== "available" ? `skill_${entry.status}` : state.eligibility,
					reason: state.reasons.join(", ") || "Skill is not eligible in this workspace",
				});
				continue;
			}
			if (!runtimeSkills.has(skillId)) {
				diagnostics.push({
					skillId,
					code: "skill_unavailable",
					reason: "Skill content could not be loaded",
				});
				continue;
			}
			candidates.push({
				skillId,
				name: entry.name,
				canonicalPath: entry.canonicalPath,
				effectiveSource: state.effectiveSource,
			});
		}
		const resolvedCandidates = resolveSkillCandidates(candidates);
		for (const resolution of resolvedCandidates.resolutions) {
			if (resolution.shadowedSkillIds.length === 0) continue;
			diagnostics.push({
				skillId: resolution.activeSkillId,
				code: "name_conflict",
				reason: `Only one Skill named ${resolution.name} can be active`,
				relatedSkillIds: resolution.shadowedSkillIds,
			});
		}
		const activeSkills: Skill[] = [];
		for (const skillId of resolvedCandidates.activeSkillIds) {
			const runtime = runtimeSkills.get(skillId);
			if (runtime) activeSkills.push(runtime);
		}
		activeSkills.sort((left, right) => compareSkillOrder(left.name, left.filePath, right.name, right.filePath));
		const resolved: ResolvedSessionSkills = {
			activeSkillIds: resolvedCandidates.activeSkillIds,
			resolutions: resolvedCandidates.resolutions,
			diagnostics,
		};
		return { profile: cloneSessionSkillsProfile(profile), resolved, activeSkills };
	}

	async #loadRuntimeSkills(): Promise<Map<string, Skill>> {
		const cwd = this.#cwd;
		const capability = await loadCapability<CapabilitySkill>(skillCapability.id, {
			cwd,
			includeDisabled: true,
			includeInvalid: true,
		});
		const records: Array<{ capability: CapabilitySkill; source: SourceMeta }> = capability.all.map(skill => ({
			capability: skill,
			source: skill._source,
		}));
		for (const configuredDirectory of this.#session.settings.getGroup("skills").customDirectories ?? []) {
			const directory = path.resolve(expandTilde(configuredDirectory));
			const scanned = await scanSkillsFromDir(
				{ cwd, home: os.homedir(), repoRoot: null },
				{ dir: directory, providerId: "custom", level: "user", requireDescription: true },
			);
			for (const skill of scanned.items) {
				records.push({ capability: skill, source: { ...skill._source, providerName: "Custom" } });
			}
		}
		const result = new Map<string, Skill>();
		await Promise.all(
			records.map(async record => {
				try {
					if (
						record.source.provider === MANAGED_SKILLS_PROVIDER_ID &&
						!isValidManagedSkillName(record.capability.name)
					) {
						return;
					}
					const canonicalPath = await fs.realpath(record.capability.path);
					result.set(createSkillId(canonicalPath), this.#runtimeSkill(record.capability, record.source));
				} catch {}
			}),
		);
		return result;
	}

	#runtimeSkill(capability: CapabilitySkill, source: SourceMeta): Skill {
		const rawDescription =
			typeof capability.frontmatter?.description === "string" ? capability.frontmatter.description : "";
		return {
			name: capability.name,
			description:
				source.provider === MANAGED_SKILLS_PROVIDER_ID
					? sanitizeManagedDescription(rawDescription)
					: rawDescription,
			filePath: capability.path,
			baseDir: path.dirname(capability.path),
			source: `${source.provider}:${capability.level}`,
			...(capability.containRoot ? { containRoot: capability.containRoot } : {}),
			hide: capability.frontmatter?.hide === true || capability.frontmatter?.disableModelInvocation === true,
			_source: source,
		};
	}
}
