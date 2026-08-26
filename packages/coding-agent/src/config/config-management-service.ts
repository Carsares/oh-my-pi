import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentRegistry } from "../registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../sdk";
import type { SessionManager } from "../session/session-manager";
import { ChatConfigManagementService, isChatConfigManagementOperation } from "./chat-config-management-service";
import healthPrompt from "./model-health-prompt.md" with { type: "text" };
import type { ModelRegistry } from "./model-registry";
import type { Settings } from "./settings";

type ModelHealthStatus = "unknown" | "healthy" | "unhealthy";

type ModelHealth = {
	status: ModelHealthStatus;
	checkedAt?: string;
	latencyMs?: number;
	error?: string;
};

type ModelPreferencesFile = {
	visibility?: Record<string, boolean>;
	health?: Record<string, ModelHealth>;
};

type CatalogModel = {
	provider?: string;
	id?: string;
	name?: string;
	contextWindow?: number | null;
};

type ApiKeyCredential = { type: "api_key"; key: string };

export type ConfigModelRegistry = {
	getAll: () => CatalogModel[];
	getAvailable: () => CatalogModel[] | Promise<CatalogModel[]>;
	getProviderAuthStatus?: (provider: string) => {
		configured?: boolean;
		source?: string;
		label?: string;
	};
	getProviderDisplayName?: (provider: string) => string;
	refresh: (strategy?: "offline" | "online" | "online-if-uncached") => void | Promise<void>;
	getApiKey?: unknown;
	resolver?: unknown;
	authStorage?: {
		getCredentialOrigin?: (provider: string) => { kind?: string } | undefined;
		hasAuth?: (provider: string) => boolean;
		set?: (provider: string, value: ApiKeyCredential) => void | Promise<void>;
		remove?: (provider: string) => void | Promise<void>;
	};
};

type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";

export type ConfigManagementResult = { ok: true; data?: unknown } | { ok: false; error: string };

export type ConfigManagementServiceOptions = {
	modelRegistry?: ConfigModelRegistry;
	settings: Settings;
	cwd?: string;
	isProjectTrusted?: () => boolean;
	agentDir?: string;
	createAgentSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	createSessionManager?: () => SessionManager;
	createAgentRegistry?: () => AgentRegistry;
};

const CONFIG_MANAGEMENT_OPERATIONS = new Set([
	"list_model_catalog",
	"set_model_visibility",
	"check_model_health",
	"set_api_key",
	"remove_api_key",
	"read_agent_config",
	"write_agent_config",
	"get_default_thinking_level",
	"set_default_thinking_level",
	"get_default_auto_compaction",
	"set_default_auto_compaction",
	"read_models_config",
	"write_models_config",
]);

const MODEL_REGISTRY_REFRESH_TIMEOUT_MS = 2_000;
const PROJECT_CONFIG_DIR_NAME = ".omp";
const THINKING_LEVELS = new Set<ThinkingLevel>(["minimal", "low", "medium", "high", "xhigh", "max", "auto"]);

export function isConfigManagementOperation(operation: string): boolean {
	return CONFIG_MANAGEMENT_OPERATIONS.has(operation) || isChatConfigManagementOperation(operation);
}

export function configOperationNeedsModelRegistry(operation: string): boolean {
	return ["list_model_catalog", "check_model_health", "set_api_key", "remove_api_key", "write_models_config"].includes(
		operation,
	);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function modelPreferenceKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

function formatModelHealth(value: unknown): ModelHealth {
	if (!value || typeof value !== "object") return { status: "unknown" };
	const candidate = value as Partial<ModelHealth>;
	if (candidate.status !== "healthy" && candidate.status !== "unhealthy") {
		return { status: "unknown" };
	}
	const health: ModelHealth = {
		status: candidate.status,
		checkedAt: typeof candidate.checkedAt === "string" ? candidate.checkedAt : undefined,
		latencyMs: typeof candidate.latencyMs === "number" ? candidate.latencyMs : undefined,
	};
	if (typeof candidate.error === "string") health.error = candidate.error;
	return health;
}

function sanitizeHealthError(error: unknown): string {
	const raw = errorMessage(error) || "Health check failed";
	return raw
		.replace(/sk-[A-Za-z0-9_-]{6,}/g, "[REDACTED]")
		.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "bearer [REDACTED]")
		.slice(0, 240);
}

function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

class ModelPreferencesStore {
	constructor(readonly path: string) {}

	read(): Required<ModelPreferencesFile> {
		if (!fs.existsSync(this.path)) return { visibility: {}, health: {} };
		try {
			const parsed = JSON.parse(fs.readFileSync(this.path, "utf8")) as ModelPreferencesFile;
			return {
				visibility:
					parsed.visibility && typeof parsed.visibility === "object" && !Array.isArray(parsed.visibility)
						? parsed.visibility
						: {},
				health:
					parsed.health && typeof parsed.health === "object" && !Array.isArray(parsed.health) ? parsed.health : {},
			};
		} catch {
			return { visibility: {}, health: {} };
		}
	}

	write(next: Required<ModelPreferencesFile>): void {
		fs.mkdirSync(path.dirname(this.path), { recursive: true });
		fs.writeFileSync(this.path, JSON.stringify(next, null, 2), "utf8");
	}

	setVisibility(provider: string, modelId: string, visible: boolean): void {
		const preferences = this.read();
		preferences.visibility[modelPreferenceKey(provider, modelId)] = visible;
		this.write(preferences);
	}

	setHealth(provider: string, modelId: string, health: ModelHealth): void {
		const preferences = this.read();
		preferences.health[modelPreferenceKey(provider, modelId)] = formatModelHealth(health);
		this.write(preferences);
	}
}

function providerAuthStatus(
	registry: ConfigModelRegistry,
	provider: string,
	availableKeys: Set<string>,
	allModels: CatalogModel[],
): { configured: boolean; source?: string; label?: string } {
	const status = registry.getProviderAuthStatus?.(provider);
	if (status) return { ...status, configured: Boolean(status.configured) };

	const origin = registry.authStorage?.getCredentialOrigin?.(provider);
	const configured =
		Boolean(origin) ||
		Boolean(registry.authStorage?.hasAuth?.(provider)) ||
		allModels.some(
			model =>
				model.provider === provider &&
				typeof model.id === "string" &&
				availableKeys.has(modelPreferenceKey(provider, model.id)),
		);
	const source =
		origin?.kind === "api_key" || origin?.kind === "oauth"
			? "stored"
			: origin?.kind === "runtime"
				? "runtime"
				: origin?.kind;
	return { configured, source, label: origin?.kind };
}

async function buildModelCatalog(registry: ConfigModelRegistry, preferences: ModelPreferencesStore) {
	const allModels = registry.getAll();
	const availableModels = await registry.getAvailable();
	const availableKeys = new Set(
		availableModels
			.filter(model => model.provider && model.id)
			.map(model => modelPreferenceKey(model.provider as string, model.id as string)),
	);
	const storedPreferences = preferences.read();
	const providerNames = Array.from(new Set(allModels.map(model => model.provider).filter(Boolean))).sort() as string[];

	return {
		providers: providerNames.map(providerName => {
			const status = providerAuthStatus(registry, providerName, availableKeys, allModels);
			return {
				provider: providerName,
				displayName: registry.getProviderDisplayName?.(providerName) ?? providerName,
				configured: Boolean(status.configured),
				source: status.source,
				label: status.label,
				models: allModels
					.filter(
						model =>
							model.provider === providerName &&
							model.id &&
							availableKeys.has(modelPreferenceKey(providerName, model.id as string)),
					)
					.sort((left, right) => String(left.id).localeCompare(String(right.id)))
					.map(model => {
						const modelId = model.id as string;
						return {
							provider: providerName,
							id: modelId,
							name: model.name,
							contextWindow: model.contextWindow,
							available: availableKeys.has(modelPreferenceKey(providerName, modelId)),
							visible: storedPreferences.visibility[modelPreferenceKey(providerName, modelId)] !== false,
							health: formatModelHealth(storedPreferences.health[modelPreferenceKey(providerName, modelId)]),
						};
					}),
			};
		}),
	};
}

function isNativeModelRegistry(registry: ConfigModelRegistry): boolean {
	return typeof registry.getApiKey === "function" && typeof registry.resolver === "function";
}

function readSettingsObject(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	let parsed: unknown;
	try {
		parsed = parseYaml(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new Error(
			`OMP settings at ${filePath} must be valid YAML: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (parsed === null || parsed === undefined) return {};
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`OMP settings must be a YAML mapping: ${filePath}`);
	}
	return parsed as Record<string, unknown>;
}

function writeYamlObjectAtomically(filePath: string, value: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporary = path.join(
		path.dirname(filePath),
		`.omp-config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
	);
	try {
		fs.writeFileSync(temporary, stringifyYaml(value), "utf8");
		fs.renameSync(temporary, filePath);
	} finally {
		try {
			if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
		} catch {
			// Best-effort cleanup only.
		}
	}
}

function readYamlConfigAsJson(filePath: string, fallback: Record<string, unknown>) {
	const value = fs.existsSync(filePath) ? readSettingsObject(filePath) : fallback;
	return { content: `${JSON.stringify(value, null, 2)}\n`, path: filePath };
}

function writeYamlConfigFromJson(filePath: string, content: unknown, label: string): void {
	if (typeof content !== "string") throw new Error("content must be a string");
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(`content is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${label} must be a JSON object`);
	}
	writeYamlObjectAtomically(filePath, parsed as Record<string, unknown>);
}

async function refreshRegistryBestEffort(registry?: ConfigModelRegistry): Promise<boolean> {
	if (!registry) return false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const { promise, resolve } = Promise.withResolvers<false>();
	try {
		timer = setTimeout(() => resolve(false), MODEL_REGISTRY_REFRESH_TIMEOUT_MS);
		timer.unref?.();
		const refresh = (async () => {
			await registry.refresh();
			return true;
		})().catch(() => false);
		return await Promise.race([refresh, promise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export class ConfigManagementService {
	readonly #agentConfigPath: string;
	readonly #agentDir: string;
	readonly #chatConfigManagement: ChatConfigManagementService;
	readonly #createAgentRegistry?: () => AgentRegistry;
	readonly #createAgentSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	readonly #createSessionManager?: () => SessionManager;
	readonly #cwd?: string;
	readonly #isProjectTrusted?: () => boolean;
	readonly #modelsConfigPath: string;
	readonly #modelRegistry?: ConfigModelRegistry;
	readonly #preferences: ModelPreferencesStore;
	readonly #settings: Settings;

	constructor(options: ConfigManagementServiceOptions) {
		this.#agentDir = options.agentDir ?? getAgentDir();
		this.#agentConfigPath = path.join(this.#agentDir, "config.yml");
		this.#modelsConfigPath = path.join(this.#agentDir, "models.yml");
		this.#preferences = new ModelPreferencesStore(path.join(this.#agentDir, "picot-models.json"));
		this.#chatConfigManagement = new ChatConfigManagementService({ agentDir: this.#agentDir });
		this.#modelRegistry = options.modelRegistry;
		this.#settings = options.settings;
		this.#cwd = options.cwd;
		this.#isProjectTrusted = options.isProjectTrusted;
		this.#createAgentSession = options.createAgentSession;
		this.#createSessionManager = options.createSessionManager;
		this.#createAgentRegistry = options.createAgentRegistry;
	}

	async request(operation: string, params: Record<string, unknown>): Promise<ConfigManagementResult> {
		if (isChatConfigManagementOperation(operation)) {
			return await this.#chatConfigManagement.request(operation, params);
		}
		try {
			switch (operation) {
				case "list_model_catalog":
					return { ok: true, data: await buildModelCatalog(this.#requireRegistry(), this.#preferences) };
				case "set_model_visibility":
					return { ok: true, data: this.#setModelVisibility(params) };
				case "check_model_health":
					return { ok: true, data: await this.#checkModelHealth(params) };
				case "set_api_key":
					return { ok: true, data: await this.#setApiKey(params) };
				case "remove_api_key":
					return { ok: true, data: await this.#removeApiKey(params) };
				case "read_agent_config":
					return { ok: true, data: readYamlConfigAsJson(this.#agentConfigPath, {}) };
				case "write_agent_config":
					return { ok: true, data: await this.#writeAgentConfig(params.content) };
				case "get_default_thinking_level":
					return { ok: true, data: this.#getDefaultThinkingLevel(params.scope) };
				case "set_default_thinking_level":
					return { ok: true, data: await this.#setDefaultThinkingLevel(params.level, params.scope) };
				case "get_default_auto_compaction":
					return { ok: true, data: this.#getDefaultAutoCompaction(params.scope) };
				case "set_default_auto_compaction":
					return { ok: true, data: await this.#setDefaultAutoCompaction(params.enabled, params.scope) };
				case "read_models_config":
					return {
						ok: true,
						data: readYamlConfigAsJson(this.#modelsConfigPath, { providers: {} }),
					};
				case "write_models_config":
					return { ok: true, data: await this.#writeModelsConfig(params.content) };
				default:
					throw new Error(`Unsupported configuration operation: ${operation}`);
			}
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}

	#requireRegistry(): ConfigModelRegistry {
		if (!this.#modelRegistry) throw new Error("Model registry not ready yet — try again in a moment.");
		return this.#modelRegistry;
	}

	#setModelVisibility(params: Record<string, unknown>) {
		const provider = asString(params.provider);
		const modelId = asString(params.modelId);
		if (!provider || !modelId) throw new Error("provider and modelId are required");
		const visible = params.visible !== false;
		this.#preferences.setVisibility(provider, modelId, visible);
		return { provider, modelId, visible };
	}

	async #checkModelHealth(params: Record<string, unknown>) {
		const registry = this.#requireRegistry();
		if (!isNativeModelRegistry(registry)) throw new Error("OMP model registry is unavailable");
		if (!this.#createAgentSession || !this.#createSessionManager || !this.#createAgentRegistry) {
			throw new Error("OMP model health check is unavailable");
		}
		const provider = asString(params.provider);
		const modelId = asString(params.modelId);
		if (!provider) throw new Error("provider is required");
		const availableKeys = new Set(
			(await registry.getAvailable())
				.filter(model => model.provider && model.id)
				.map(model => modelPreferenceKey(model.provider as string, model.id as string)),
		);
		const models = registry.getAll().filter(model => {
			if (model.provider !== provider || !model.id) return false;
			if (modelId) return model.id === modelId;
			return availableKeys.has(modelPreferenceKey(provider, model.id));
		});
		if (models.length === 0) throw new Error("No matching models available for health check");
		const results = [];
		for (const model of models) results.push(await this.#startModelHealthCheck(registry, model));
		return { results };
	}

	async #startModelHealthCheck(registry: ConfigModelRegistry, model: CatalogModel) {
		const provider = model.provider as string;
		const modelId = model.id as string;
		const startedAt = Date.now();
		let sawAssistantText = false;
		try {
			const { session } = await this.#createAgentSession!({
				model: model as Model<Api>,
				thinkingLevel: "off",
				modelRegistry: registry as ModelRegistry,
				settings: this.#settings,
				toolNames: [],
				restrictToolNames: true,
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				sessionManager: this.#createSessionManager!(),
				agentRegistry: this.#createAgentRegistry!(),
			});
			try {
				const unsubscribe = session.subscribe(event => {
					if (!("assistantMessageEvent" in event)) return;
					const assistantEvent = event.assistantMessageEvent;
					if (
						assistantEvent?.type === "text_delta" &&
						typeof assistantEvent.delta === "string" &&
						assistantEvent.delta.length > 0
					) {
						sawAssistantText = true;
					}
				});
				try {
					await session.prompt(healthPrompt.trim());
				} finally {
					unsubscribe();
				}
			} finally {
				await session.dispose();
			}
			const result: { provider: string; modelId: string } & ModelHealth = {
				provider,
				modelId,
				status: sawAssistantText ? "healthy" : "unhealthy",
				checkedAt: new Date().toISOString(),
				latencyMs: Date.now() - startedAt,
				error: sawAssistantText ? undefined : "No assistant text returned",
			};
			this.#preferences.setHealth(provider, modelId, result);
			return result;
		} catch (error) {
			const result: { provider: string; modelId: string } & ModelHealth = {
				provider,
				modelId,
				status: "unhealthy",
				checkedAt: new Date().toISOString(),
				latencyMs: Date.now() - startedAt,
				error: sanitizeHealthError(error),
			};
			this.#preferences.setHealth(provider, modelId, result);
			return result;
		}
	}

	async #setApiKey(params: Record<string, unknown>) {
		const registry = this.#modelRegistry;
		const provider = asString(params.provider);
		const apiKey = asString(params.apiKey);
		if (!provider) throw new Error("provider is required");
		if (!apiKey) throw new Error("apiKey is required");
		if (!registry?.authStorage?.set) throw new Error("OMP model registry is unavailable");
		await registry.authStorage.set(provider, { type: "api_key", key: apiKey });
		await registry.refresh();
		return { provider };
	}

	async #removeApiKey(params: Record<string, unknown>) {
		const registry = this.#modelRegistry;
		const provider = asString(params.provider);
		if (!provider) throw new Error("provider is required");
		if (!registry?.authStorage?.remove) throw new Error("OMP model registry is unavailable");
		await registry.authStorage.remove(provider);
		await registry.refresh();
		return { provider };
	}

	async #writeAgentConfig(content: unknown) {
		await this.#settings.flush();
		writeYamlConfigFromJson(this.#agentConfigPath, content, "config.yml");
		await this.#settings.reloadFromDisk();
		return { path: this.#agentConfigPath };
	}

	#resolveSettingsPath(scope: unknown): { scope: "global" | "project"; path: string } {
		const requestedScope = asString(scope) || "global";
		if (requestedScope === "global") return { scope: "global", path: this.#agentConfigPath };
		if (requestedScope !== "project") throw new Error(`Unsupported settings scope: ${requestedScope}`);
		const cwd = asString(this.#cwd);
		if (!cwd) throw new Error("Project settings require an active workspace");
		if (this.#isProjectTrusted && !this.#isProjectTrusted()) {
			throw new Error("Project settings cannot be changed until the workspace is trusted");
		}
		return { scope: "project", path: path.join(cwd, PROJECT_CONFIG_DIR_NAME, "config.yml") };
	}

	#projectSettings(): { path: string; settings: Record<string, unknown> } | null {
		const cwd = asString(this.#cwd);
		if (!cwd || (this.#isProjectTrusted && !this.#isProjectTrusted())) return null;
		const settingsPath = path.join(cwd, PROJECT_CONFIG_DIR_NAME, "config.yml");
		return { path: settingsPath, settings: readSettingsObject(settingsPath) };
	}

	#getDefaultThinkingLevel(scope: unknown) {
		const requestedScope = asString(scope) || "global";
		if (requestedScope === "project" || requestedScope === "effective") {
			const project = this.#projectSettings();
			const projectValue = project?.settings.defaultThinkingLevel;
			if (project && typeof projectValue === "string" && THINKING_LEVELS.has(projectValue as ThinkingLevel)) {
				return { level: projectValue, source: "project", path: project.path };
			}
			if (requestedScope === "project") {
				return { level: "high", source: "omp_default", path: this.#resolveSettingsPath("project").path };
			}
		}
		const globalValue = readSettingsObject(this.#agentConfigPath).defaultThinkingLevel;
		if (typeof globalValue === "string" && THINKING_LEVELS.has(globalValue as ThinkingLevel)) {
			return { level: globalValue, source: "global", path: this.#agentConfigPath };
		}
		return { level: "high", source: "omp_default", path: this.#agentConfigPath };
	}

	async #setDefaultThinkingLevel(level: unknown, scope: unknown) {
		const thinkingLevel = asString(level);
		if (!THINKING_LEVELS.has(thinkingLevel as ThinkingLevel)) {
			throw new Error(`Unsupported thinking level: ${thinkingLevel || String(level)}`);
		}
		const target = this.#resolveSettingsPath(scope);
		await this.#settings.flush();
		const nextSettings = readSettingsObject(target.path);
		nextSettings.defaultThinkingLevel = thinkingLevel;
		writeYamlObjectAtomically(target.path, nextSettings);
		await this.#settings.reloadFromDisk();
		return { level: thinkingLevel, scope: target.scope, path: target.path };
	}

	#getDefaultAutoCompaction(scope: unknown) {
		const requestedScope = asString(scope) || "global";
		if (requestedScope === "project" || requestedScope === "effective") {
			const project = this.#projectSettings();
			const projectValue = project ? this.#compactionEnabled(project.settings) : undefined;
			if (typeof projectValue === "boolean") {
				return { enabled: projectValue, source: "project", path: project?.path };
			}
			if (requestedScope === "project") {
				return { enabled: true, source: "omp_default", path: this.#resolveSettingsPath("project").path };
			}
		}
		const globalValue = this.#compactionEnabled(readSettingsObject(this.#agentConfigPath));
		if (typeof globalValue === "boolean") {
			return { enabled: globalValue, source: "global", path: this.#agentConfigPath };
		}
		return { enabled: true, source: "omp_default", path: this.#agentConfigPath };
	}

	#compactionEnabled(settings: Record<string, unknown>): boolean | undefined {
		const compaction = settings.compaction;
		if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) return undefined;
		const enabled = (compaction as Record<string, unknown>).enabled;
		return typeof enabled === "boolean" ? enabled : undefined;
	}

	async #setDefaultAutoCompaction(enabled: unknown, scope: unknown) {
		if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
		const target = this.#resolveSettingsPath(scope);
		await this.#settings.flush();
		const nextSettings = readSettingsObject(target.path);
		const existing = nextSettings.compaction;
		const compaction =
			existing && typeof existing === "object" && !Array.isArray(existing)
				? { ...(existing as Record<string, unknown>) }
				: {};
		compaction.enabled = enabled;
		nextSettings.compaction = compaction;
		writeYamlObjectAtomically(target.path, nextSettings);
		await this.#settings.reloadFromDisk();
		return { enabled, scope: target.scope, path: target.path };
	}

	async #writeModelsConfig(content: unknown) {
		if (typeof content !== "string") throw new Error("content must be a string");
		const parsed = JSON.parse(content) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("models.yml must be a JSON object");
		}
		if ("providers" in parsed && (typeof parsed.providers !== "object" || Array.isArray(parsed.providers))) {
			throw new Error("'providers' must be an object");
		}
		writeYamlConfigFromJson(this.#modelsConfigPath, content, "models.yml");
		const refreshed = await refreshRegistryBestEffort(this.#modelRegistry);
		return { path: this.#modelsConfigPath, refreshed };
	}
}
