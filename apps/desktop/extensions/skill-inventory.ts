// ABOUTME: Adapts OMP skill discovery and enablement to Picot's Settings inventory DTOs.
// ABOUTME: Persists exact OMP skill IDs in config.yml without duplicating discovery rules.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Skill as OmpSkill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { scanSkillsFromDir } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { minimatch } from "minimatch";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type SkillScope = "global" | "project";
export type SkillTarget = { kind: "group" | "skill"; id: string };
export type SkillStatus = "enabled" | "disabled" | "shadowed" | "invalid";

export type SkillInventoryItem = {
  kind: "skill";
  id: string;
  canonicalPath: string;
  name: string;
  description: string;
  enabled: boolean;
  status: SkillStatus;
  ruleBaseDir: string;
  ruleRelativeDir: string;
  treePath: string;
  sourceRoot: string;
  scope: "user" | "project";
  source: "auto" | "local";
  matchingRules: string[];
  ambiguous: boolean;
  shadowedBy?: { id: string; canonicalPath: string; name: string };
};

export type SkillGroupNode = {
  kind: "group";
  id: string;
  sourceRoot: string;
  ruleBaseDir: string;
  ruleBaseRelativePath: string;
  name: string;
  scope: "user" | "project";
  source: "auto" | "local";
  state: "all-on" | "all-off" | "mixed";
  ambiguous: boolean;
  children: SkillChild[];
};

export type SkillChild = SkillInventoryItem | SkillGroupNode;
export type SkillRootKind = "pi" | "agents" | "configured";

export type SkillRoot = {
  sourceRoot: string;
  ruleBaseDir: string;
  scope: "user" | "project";
  source: "auto" | "local";
  rootKind?: SkillRootKind;
  children: SkillChild[];
};

export type SkillDiagnostic = { path?: string; message: string };

export type SkillInventory = {
  scope: SkillScope;
  settingsPath: string;
  trusted: boolean;
  roots: SkillRoot[];
  customRules: string[];
  discoveredRoots: string[];
  diagnostics: SkillDiagnostic[];
};

export type SkillMutationResult = {
  inventory: SkillInventory;
  runtimeRestartRequired: true;
};

type OmpSkillsSettings = {
  enabled?: boolean;
  enableCodexUser?: boolean;
  enableClaudeUser?: boolean;
  enableClaudeProject?: boolean;
  enablePiUser?: boolean;
  enablePiProject?: boolean;
  enableAgentsUser?: boolean;
  enableAgentsProject?: boolean;
  customDirectories?: string[];
  ignoredSkills?: string[];
  includeSkills?: string[];
};

export type SkillSettingsRuntime = {
  get(path: "disabledExtensions"): string[] | undefined;
  getGroup(path: "skills"): OmpSkillsSettings;
  flush(): Promise<void>;
  reloadFromDisk(): Promise<void>;
};

export type BuildSkillInventoryOptions = {
  scope: SkillScope;
  cwd: string;
  agentDir: string;
  homeDir?: string;
  projectTrusted?: boolean;
  settingsRuntime?: SkillSettingsRuntime;
};

export type MutateSkillEnabledOptions = BuildSkillInventoryOptions & {
  target: SkillTarget;
  enabled: boolean;
};

type CapabilitySkill = OmpSkill & { _source: SourceMeta; _shadowed?: boolean };
type InventoryCandidate = CapabilitySkill & { custom: boolean; canonicalPath: string };

const MANAGED_SKILLS_PROVIDER_ID = "omp-managed";
const mutationQueues = new Map<string, Promise<unknown>>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsPathFor(scope: SkillScope, opts: BuildSkillInventoryOptions): string {
  return scope === "global"
    ? path.join(opts.agentDir, "config.yml")
    : path.join(opts.cwd, ".omp", "config.yml");
}

function readYamlObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "parse error";
    throw new Error(`OMP config at ${filePath} must be valid YAML: ${message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) throw new Error(`OMP config must be a YAML object: ${filePath}`);
  return parsed;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function settingsFromDisk(opts: BuildSkillInventoryOptions): {
  skills: OmpSkillsSettings;
  disabledExtensions: string[];
} {
  const globalConfig = readYamlObject(path.join(opts.agentDir, "config.yml"));
  const projectConfig = opts.projectTrusted
    ? readYamlObject(path.join(opts.cwd, ".omp", "config.yml"))
    : {};
  const globalSkills = isPlainObject(globalConfig.skills) ? globalConfig.skills : {};
  const projectSkills = isPlainObject(projectConfig.skills) ? projectConfig.skills : {};
  return {
    skills: { ...globalSkills, ...projectSkills } as OmpSkillsSettings,
    disabledExtensions: stringArray(
      projectConfig.disabledExtensions ?? globalConfig.disabledExtensions,
    ),
  };
}

function effectiveSettings(opts: BuildSkillInventoryOptions): {
  skills: OmpSkillsSettings;
  disabledExtensions: string[];
} {
  const runtime = opts.settingsRuntime;
  if (!runtime) return settingsFromDisk(opts);
  return {
    skills: runtime.getGroup("skills") ?? {},
    disabledExtensions: stringArray(runtime.get("disabledExtensions")),
  };
}

function matchesName(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(name, pattern));
}

function sourceEnabled(source: SourceMeta, skills: OmpSkillsSettings): boolean {
  const {
    enableCodexUser = true,
    enableClaudeUser = true,
    enableClaudeProject = true,
    enablePiUser = true,
    enablePiProject = true,
    enableAgentsUser = true,
    enableAgentsProject = true,
  } = skills;
  if (source.provider === MANAGED_SKILLS_PROVIDER_ID) return true;
  if (source.provider === "codex" && source.level === "user") return enableCodexUser;
  if (source.provider === "claude" && source.level === "user") return enableClaudeUser;
  if (source.provider === "claude" && source.level === "project") return enableClaudeProject;
  if (source.provider === "native" && source.level === "user") return enablePiUser;
  if (source.provider === "native" && source.level === "project") return enablePiProject;
  if (source.provider === "agents" && source.level === "user") return enableAgentsUser;
  if (source.provider === "agents" && source.level === "project") return enableAgentsProject;
  return (
    enableCodexUser || enableClaudeUser || enableClaudeProject || enablePiUser || enablePiProject
  );
}

function candidateEnabled(
  candidate: InventoryCandidate,
  skills: OmpSkillsSettings,
  disabledExtensions: Set<string>,
): { enabled: boolean; matchingRules: string[] } {
  const matchingRules: string[] = [];
  if (skills.enabled === false) matchingRules.push("skills.enabled=false");
  if (!sourceEnabled(candidate._source, skills)) {
    matchingRules.push(`skills.${candidate._source.provider}=false`);
  }
  const extensionId = `skill:${candidate.name}`;
  if (disabledExtensions.has(extensionId)) matchingRules.push(extensionId);
  const ignored = stringArray(skills.ignoredSkills);
  if (matchesName(candidate.name, ignored)) matchingRules.push(`ignored:${candidate.name}`);
  const included = stringArray(skills.includeSkills);
  if (included.length > 0 && !matchesName(candidate.name, included)) {
    matchingRules.push(`not-included:${candidate.name}`);
  }
  return { enabled: matchingRules.length === 0, matchingRules };
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function loadCandidates(
  opts: BuildSkillInventoryOptions,
  skills: OmpSkillsSettings,
): Promise<{ candidates: InventoryCandidate[]; diagnostics: SkillDiagnostic[] }> {
  const result = await loadCapability<OmpSkill>("skills", {
    cwd: opts.cwd,
    includeDisabled: true,
    includeInvalid: true,
  });
  const diagnostics: SkillDiagnostic[] = result.warnings.map((message) => ({ message }));
  const authored = result.all.filter(
    (skill): skill is CapabilitySkill => skill._source?.level !== "native",
  );
  const native = result.all.filter(
    (skill): skill is CapabilitySkill => skill._source?.level === "native",
  );
  const customResults = await Promise.all(
    stringArray(skills.customDirectories).map(async (dir) => {
      const expanded =
        dir === "~"
          ? (opts.homeDir ?? "")
          : dir.startsWith("~/")
            ? path.join(opts.homeDir ?? "", dir.slice(2))
            : dir;
      const scan = await scanSkillsFromDir(
        { cwd: opts.cwd, home: opts.homeDir ?? "", repoRoot: null },
        { dir: expanded, providerId: "custom", level: "user", requireDescription: true },
      );
      diagnostics.push(...(scan.warnings ?? []).map((message) => ({ path: expanded, message })));
      return scan.items as CapabilitySkill[];
    }),
  );
  const ordered = [
    ...customResults.flat().map((skill) => ({ skill, custom: true })),
    ...authored
      .filter((skill) => skill._source.provider !== MANAGED_SKILLS_PROVIDER_ID)
      .map((skill) => ({ skill, custom: false })),
    ...authored
      .filter((skill) => skill._source.provider === MANAGED_SKILLS_PROVIDER_ID)
      .map((skill) => ({ skill, custom: false })),
    ...native.map((skill) => ({ skill, custom: false })),
  ];
  const candidates = await Promise.all(
    ordered.map(async ({ skill, custom }) => ({
      ...skill,
      custom,
      canonicalPath: await canonicalPath(skill.path),
    })),
  );
  const seenPaths = new Set<string>();
  return {
    candidates: candidates.filter((candidate) => {
      if (seenPaths.has(candidate.canonicalPath)) return false;
      seenPaths.add(candidate.canonicalPath);
      return true;
    }),
    diagnostics,
  };
}

function rootKind(candidate: InventoryCandidate): SkillRootKind {
  if (candidate.custom) return "configured";
  if (candidate._source.provider === "agents") return "agents";
  return "pi";
}

function toInventoryItem(
  candidate: InventoryCandidate,
  enabled: boolean,
  matchingRules: string[],
): SkillInventoryItem {
  const skillDir = path.dirname(candidate.canonicalPath);
  const sourceRoot = path.dirname(skillDir);
  const level = candidate._source.level === "project" ? "project" : "user";
  return {
    kind: "skill",
    id: candidate.canonicalPath,
    canonicalPath: candidate.canonicalPath,
    name: candidate.name,
    description:
      typeof candidate.frontmatter?.description === "string"
        ? candidate.frontmatter.description
        : "",
    enabled,
    status: enabled ? "enabled" : "disabled",
    ruleBaseDir: sourceRoot,
    ruleRelativeDir: path.basename(skillDir),
    treePath: path.basename(skillDir),
    sourceRoot,
    scope: level,
    source: candidate.custom ? "local" : "auto",
    matchingRules,
    ambiguous: false,
  };
}

function sortRoots(roots: SkillRoot[]): void {
  roots.sort((left, right) => left.sourceRoot.localeCompare(right.sourceRoot));
  for (const root of roots) {
    root.children.sort((left, right) => left.name.localeCompare(right.name));
  }
}

export function findSkillInRoots(roots: SkillRoot[], id: string): SkillInventoryItem | undefined {
  for (const root of roots) {
    for (const child of root.children) {
      if (child.kind === "skill" && child.id === id) return child;
    }
  }
  return undefined;
}

export function findGroupInRoots(roots: SkillRoot[], id: string): SkillGroupNode | undefined {
  for (const root of roots) {
    for (const child of root.children) {
      if (child.kind === "group" && child.id === id) return child;
    }
  }
  return undefined;
}

export async function buildSkillInventory(
  opts: BuildSkillInventoryOptions,
): Promise<SkillInventory> {
  const trusted = Boolean(opts.projectTrusted);
  const settingsPath = settingsPathFor(opts.scope, opts);
  if (opts.scope === "project" && !trusted) {
    return {
      scope: opts.scope,
      settingsPath,
      trusted,
      roots: [],
      customRules: [],
      discoveredRoots: [path.join(opts.cwd, ".omp", "skills")],
      diagnostics: [],
    };
  }
  const effective = effectiveSettings(opts);
  const { candidates, diagnostics } = await loadCandidates(opts, effective.skills);
  const disabledExtensions = new Set(effective.disabledExtensions);
  const items: Array<{ candidate: InventoryCandidate; item: SkillInventoryItem }> = [];
  for (const candidate of candidates) {
    const state = candidateEnabled(candidate, effective.skills, disabledExtensions);
    items.push({ candidate, item: toInventoryItem(candidate, state.enabled, state.matchingRules) });
  }
  const winners = new Map<string, SkillInventoryItem>();
  for (const { item } of items) {
    if (item.enabled && !winners.has(item.name)) winners.set(item.name, item);
  }
  for (const { item } of items) {
    if (!item.enabled) continue;
    const winner = winners.get(item.name);
    if (winner && winner.id !== item.id) {
      item.status = "shadowed";
      item.shadowedBy = { id: winner.id, canonicalPath: winner.canonicalPath, name: winner.name };
    }
  }
  const rootsByKey = new Map<string, SkillRoot>();
  for (const { candidate, item } of items) {
    const key = `${item.sourceRoot}\0${item.scope}\0${item.source}`;
    let root = rootsByKey.get(key);
    if (!root) {
      root = {
        sourceRoot: item.sourceRoot,
        ruleBaseDir: item.sourceRoot,
        scope: item.scope,
        source: item.source,
        rootKind: rootKind(candidate),
        children: [],
      };
      rootsByKey.set(key, root);
    }
    root.children.push(item);
  }
  const roots = [...rootsByKey.values()];
  sortRoots(roots);
  return {
    scope: opts.scope,
    settingsPath,
    trusted,
    roots,
    customRules: stringArray(effective.skills.customDirectories),
    discoveredRoots: roots.map((root) => root.sourceRoot),
    diagnostics,
  };
}

async function writeYamlAtomically(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.picot-skills-${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(tempPath, stringifyYaml(value), "utf8");
    await fs.promises.rename(tempPath, filePath);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function withSettingsLock<T>(
  settingsPath: string,
  critical: () => Promise<T> | T,
): Promise<T> {
  await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  return withFileLock(settingsPath, async () => await critical(), {
    retries: 150,
    retryDelayMs: 100,
  });
}

export async function updateYamlConfig(
  settingsPath: string,
  update: (settings: Record<string, unknown>) => void,
): Promise<void> {
  await withSettingsLock(settingsPath, async () => {
    const settings = readYamlObject(settingsPath);
    update(settings);
    await writeYamlAtomically(settingsPath, settings);
  });
}

function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  mutationQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export async function mutateSkillEnabled(
  opts: MutateSkillEnabledOptions,
): Promise<SkillMutationResult> {
  const settingsPath = settingsPathFor(opts.scope, opts);
  return serialized(settingsPath, async () => {
    if (opts.scope === "project" && !opts.projectTrusted) {
      throw new Error("Project is not trusted; cannot mutate project skills");
    }
    if (opts.target.kind !== "skill") throw new Error("OMP skill groups cannot be toggled");
    const inventory = await buildSkillInventory(opts);
    const item = findSkillInRoots(inventory.roots, opts.target.id);
    if (!item) throw new Error("Unknown skill target");
    const expectedScope = opts.scope === "global" ? "user" : "project";
    if (item.scope !== expectedScope)
      throw new Error("Skill does not belong to the selected scope");
    await opts.settingsRuntime?.flush();
    await updateYamlConfig(settingsPath, (config) => {
      const disabled = stringArray(config.disabledExtensions);
      const extensionId = `skill:${item.name}`;
      config.disabledExtensions = opts.enabled
        ? disabled.filter((entry) => entry !== extensionId)
        : disabled.includes(extensionId)
          ? disabled
          : [...disabled, extensionId];
    });
    await opts.settingsRuntime?.reloadFromDisk();
    return {
      inventory: await buildSkillInventory(opts),
      runtimeRestartRequired: true,
    };
  });
}
