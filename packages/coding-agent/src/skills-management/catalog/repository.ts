import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { YAML } from "bun";
import { createEmptySkillCatalog, replaceSkillCatalogRootSources } from "./catalog";
import type { SkillCatalogEntry, SkillCatalogState, SkillRootScanResult, SkillSourceRef } from "./types";

export const SKILL_CATALOG_FILENAME = "skill-catalog.yml";

export interface SkillCatalogRepositoryOptions {
	agentDir?: string;
	filePath?: string;
	now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`Skill Catalog ${field} must be a string`);
	return value;
}

function parseSource(value: unknown): SkillSourceRef {
	if (!isRecord(value)) throw new Error("Skill Catalog source must be a mapping");
	const {
		providerId,
		level,
		sourceRoot,
		discoveredPath,
		projectRoot,
		discoveryKind,
		providerPriority,
		projectDistance,
	} = value;
	if (
		typeof providerId !== "string" ||
		(level !== "user" && level !== "project") ||
		typeof sourceRoot !== "string" ||
		typeof discoveredPath !== "string" ||
		(discoveryKind !== "standard" &&
			discoveryKind !== "custom" &&
			discoveryKind !== "managed" &&
			discoveryKind !== "plugin") ||
		typeof providerPriority !== "number" ||
		(projectDistance !== undefined && typeof projectDistance !== "number")
	) {
		throw new Error("Skill Catalog source is invalid");
	}
	return {
		providerId,
		level,
		sourceRoot,
		discoveredPath,
		...(projectRoot === undefined ? {} : { projectRoot: optionalString(projectRoot, "projectRoot") }),
		discoveryKind,
		providerPriority,
		...(projectDistance === undefined ? {} : { projectDistance }),
	};
}

function parseEntry(value: unknown): SkillCatalogEntry {
	if (!isRecord(value)) throw new Error("Skill Catalog entry must be a mapping");
	const {
		skillId,
		canonicalPath,
		name,
		description,
		lastKnownName,
		lastKnownDescription,
		status,
		parseError,
		sources,
		firstSeenAt,
		lastSeenAt,
	} = value;
	if (
		typeof skillId !== "string" ||
		typeof canonicalPath !== "string" ||
		(status !== "available" && status !== "missing" && status !== "invalid") ||
		!Array.isArray(sources) ||
		typeof firstSeenAt !== "string" ||
		typeof lastSeenAt !== "string"
	) {
		throw new Error("Skill Catalog entry is invalid");
	}
	const parsedSources = sources.map(parseSource);
	const sourceKeys = parsedSources.map(
		source => `${source.providerId}\0${source.sourceRoot}\0${source.discoveredPath}`,
	);
	if (new Set(sourceKeys).size !== sourceKeys.length)
		throw new Error("Skill Catalog entry contains duplicate sources");
	return {
		skillId,
		canonicalPath,
		...(name === undefined ? {} : { name: optionalString(name, "name") }),
		...(description === undefined ? {} : { description: optionalString(description, "description") }),
		...(lastKnownName === undefined ? {} : { lastKnownName: optionalString(lastKnownName, "lastKnownName") }),
		...(lastKnownDescription === undefined
			? {}
			: { lastKnownDescription: optionalString(lastKnownDescription, "lastKnownDescription") }),
		status,
		...(parseError === undefined ? {} : { parseError: optionalString(parseError, "parseError") }),
		sources: parsedSources,
		firstSeenAt,
		lastSeenAt,
	};
}

function parseCatalog(content: string): SkillCatalogState {
	let value: unknown;
	try {
		value = YAML.parse(content);
	} catch (error) {
		throw new Error(`Unable to parse Skill Catalog: ${String(error)}`);
	}
	if (!isRecord(value)) throw new Error("Skill Catalog must be a mapping");
	const { schemaVersion, revision, entries } = value;
	if (schemaVersion !== 1 || !Number.isInteger(revision) || (revision as number) < 0 || !Array.isArray(entries)) {
		throw new Error("Skill Catalog schema or revision is invalid");
	}
	const parsedEntries = entries.map(parseEntry);
	if (new Set(parsedEntries.map(entry => entry.skillId)).size !== parsedEntries.length) {
		throw new Error("Skill Catalog contains duplicate skill IDs");
	}
	return { schemaVersion: 1, revision: revision as number, entries: parsedEntries };
}

function serializeCatalog(state: SkillCatalogState): string {
	return YAML.stringify(state, null, 2);
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(temporaryPath, content);
		await fs.rename(temporaryPath, filePath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true }).catch(() => {});
		throw error;
	}
}

/** Stores root-scoped Catalog updates under one cross-process lock. */
export class SkillCatalogRepository {
	readonly filePath: string;
	readonly #now: () => Date;

	constructor(options: SkillCatalogRepositoryOptions = {}) {
		this.filePath = options.filePath ?? path.join(options.agentDir ?? getAgentDir(), SKILL_CATALOG_FILENAME);
		this.#now = options.now ?? (() => new Date());
	}

	async getSnapshot(): Promise<SkillCatalogState> {
		return structuredClone(await this.#read());
	}

	async commitRootScan(scan: SkillRootScanResult): Promise<SkillCatalogState> {
		return await this.commitRootScans([scan]);
	}

	async commitRootScans(scans: readonly SkillRootScanResult[]): Promise<SkillCatalogState> {
		if (!scans.some(scan => scan.status === "success")) return await this.getSnapshot();
		await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		return await withFileLock(this.filePath, async () => {
			const current = await this.#read();
			const replaced = replaceSkillCatalogRootSources(current, scans, this.#now().toISOString());
			if (JSON.stringify(replaced.entries) === JSON.stringify(current.entries)) return structuredClone(current);
			const state = { ...replaced, revision: current.revision + 1 };
			await writeAtomic(this.filePath, serializeCatalog(state));
			return structuredClone(state);
		});
	}

	async #read(): Promise<SkillCatalogState> {
		try {
			return parseCatalog(await Bun.file(this.filePath).text());
		} catch (error) {
			if (isEnoent(error)) return createEmptySkillCatalog();
			throw error;
		}
	}
}
