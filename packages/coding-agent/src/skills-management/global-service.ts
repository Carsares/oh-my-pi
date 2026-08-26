// ABOUTME: Provides the workspace-neutral portion of Skill Management.
// ABOUTME: It owns the shared catalog and collection files without creating an AgentSession.

import * as os from "node:os";
import * as path from "node:path";
import { getCapabilityInfo, reset as resetCapabilities } from "../capability";
import { skillCapability } from "../capability/skill";
import type { Settings, SkillsSettings } from "../config/settings";
import {
	discoverSkillCatalogCandidates,
	type SkillCatalogEntry,
	SkillCatalogRepository,
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
import { resolveEffectiveSkillSource } from "./resolver";
import type { SkillCatalogEntryState, SkillCatalogListResult, SkillCatalogQuery, SkillEligibility } from "./types";

function sourceInWorkspace(source: SkillSourceRef, cwd: string): boolean {
	if (source.level === "user") return true;
	if (!source.projectRoot) return source.discoveredPath.startsWith(`${path.resolve(cwd)}${path.sep}`);
	const relative = path.relative(source.projectRoot, cwd);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function globMatches(name: string, patterns: readonly string[]): boolean {
	return patterns.some(pattern => new Bun.Glob(pattern).match(name));
}

/** Handles global Catalog and Collection operations without a visible session. */
export class GlobalSkillManagementService {
	readonly #settings: Settings;
	readonly #catalog: SkillCatalogRepository;
	readonly #collections: SkillCollectionsRepository;
	readonly #cwd: string;

	constructor(
		settings: Settings,
		options: {
			cwd?: string;
			catalog?: SkillCatalogRepository;
			collections?: SkillCollectionsRepository;
		} = {},
	) {
		this.#settings = settings;
		this.#cwd = path.resolve(options.cwd ?? settings.getCwd() ?? os.homedir());
		this.#catalog = options.catalog ?? new SkillCatalogRepository({ agentDir: settings.getAgentDir() });
		this.#collections = options.collections ?? new SkillCollectionsRepository({ agentDir: settings.getAgentDir() });
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
		if (query.providerId) {
			entries = entries.filter(entry => entry.sources.some(source => source.providerId === query.providerId));
		}
		if (query.status) entries = entries.filter(entry => entry.status === query.status);
		return { revision: catalog.revision, entries };
	}

	async getCatalogEntry(skillId: string): Promise<SkillCatalogEntryState> {
		const entry = (await this.#catalog.getSnapshot()).entries.find(candidate => candidate.skillId === skillId);
		if (!entry) throw new Error(`Skill does not exist: ${skillId}`);
		return this.#entryState(entry);
	}

	async rescanCatalog(): Promise<SkillCatalogListResult> {
		await this.#settings.reloadFromDisk();
		resetCapabilities();
		const discovery = await discoverSkillCatalogCandidates(this.#cwd, this.#settings.getGroup("skills"));
		await this.#catalog.commitRootScans(discovery.rootScans);
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

	createCollection(
		params: CreateCollectionParams,
		context: CollectionMutationContext,
	): Promise<CollectionMutationResult> {
		return this.#collections.create(params, context);
	}

	updateCollection(
		params: UpdateCollectionParams,
		context: CollectionMutationContext,
	): Promise<CollectionMutationResult> {
		return this.#collections.update(params, context);
	}

	deleteCollection(collectionId: string, context: CollectionMutationContext): Promise<CollectionMutationResult> {
		return this.#collections.delete(collectionId, context);
	}

	setDefaultCollection(collectionId: string, context: CollectionMutationContext): Promise<CollectionMutationResult> {
		return this.#collections.setDefault(collectionId, context);
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
		const settings = this.#settings.getGroup("skills");
		const enabledSources = workspaceSources.filter(source => this.#sourceEnabled(source, settings));
		if (workspaceSources.length > 0 && enabledSources.length === 0) reasons.push("provider_disabled");
		const name = entry.name ?? entry.lastKnownName;
		if (name && globMatches(name, settings.ignoredSkills ?? [])) reasons.push("ignored_by_name_filter");
		if (name && (settings.includeSkills?.length ?? 0) > 0 && !globMatches(name, settings.includeSkills ?? [])) {
			reasons.push("not_included_by_name_filter");
		}
		if ((this.#settings.get("disabledExtensions") ?? []).includes(`skill:${name}`)) {
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
}
