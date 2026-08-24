// ABOUTME: Scans authenticated local directories for skills available to OMP.
// ABOUTME: Adds compatible direct-child roots to skills.customDirectories after confirmation.

import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync, realpathSync, type Stats, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  canonicalizeExistingPath,
  type DiscoveredSkill,
  discoverSkillsFromRoot,
  type SkillDiagnostic,
  toPosixPath,
} from "./skill-discovery.ts";
import { updateYamlConfig } from "./skill-inventory.ts";

export type InstallCandidateSelection = { kind: "group" | "skill"; id: string };
export type InstallHostSource = {
  sourceId: string;
  canonicalPath: string;
  candidateIdKey: string;
};
export type SkillInstallCandidate = {
  kind: "skill";
  id: string;
  name: string;
  description: string;
  displayCanonicalPath: string;
};
export type SkillInstallGroup = {
  kind: "group";
  id: string;
  name: string;
  children: Array<SkillInstallGroup | SkillInstallCandidate>;
};
export type SkillInstallScan = {
  sourceId: string;
  displayCanonicalSourcePath: string;
  scanRevision: string;
  tree: Array<SkillInstallGroup | SkillInstallCandidate>;
  defaultSelection: InstallCandidateSelection[];
  diagnostics: SkillDiagnostic[];
};

export type SkillInstallPreview = {
  scope: "global" | "project";
  settingsPath: string;
  additions: string[];
  skippedEntries: string[];
};

export type SkillInstallResult = {
  scan: SkillInstallScan;
  addedEntries: string[];
  skippedEntries: string[];
  settingsChanged: boolean;
  runtimeRestartRequired: true;
};

type BuildOptions = {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  scope?: "global" | "project";
  homeDir?: string;
};

function lengthDelimited(...parts: string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

function opaqueId(
  key: string,
  sourceId: string,
  revision: string,
  kind: string,
  path: string,
): string {
  return createHmac("sha256", key)
    .update(lengthDelimited(sourceId, revision, kind, path))
    .digest("base64url");
}

function existingCanonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return canonicalizeExistingPath(path);
  }
}

/**
 * Canonicalize a path even when it does not yet exist: realpath the longest
 * existing ancestor and re-append the missing tail. This keeps symlinked
 * prefixes (e.g. macOS TMPDIR `/var` → `/private/var`) consistent with
 * realpath'd skill targets, so `path.relative(baseDir, target)` does not bail
 * out to an absolute path when baseDir and target live under different
 * spellings of the same real directory.
 */
function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const resolved = resolve(p);
    const segments = resolved.split(sep);
    for (let i = segments.length - 1; i > 0; i -= 1) {
      const ancestor = segments.slice(0, i).join(sep) || sep;
      try {
        return join(realpathSync(ancestor), ...segments.slice(i));
      } catch {
        // ancestor does not exist either; keep walking up
      }
    }
    return resolved;
  }
}

function treePath(skill: DiscoveredSkill, source: string): string[] {
  const rel = toPosixPath(relative(source, skill.skillDir));
  return rel ? rel.split("/").filter(Boolean) : [];
}

function buildRevision(source: string, skills: DiscoveredSkill[], memberships: string[]): string {
  const hash = createHash("sha256");
  hash.update(lengthDelimited("root", source));
  for (const skill of [...skills].sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath))) {
    const content = readFileSync(skill.filePath, "utf8");
    hash.update(
      lengthDelimited(
        "candidate",
        skill.canonicalPath,
        createHash("sha256").update(content).digest("hex"),
        skill.name,
        skill.description,
      ),
    );
  }
  for (const membership of [...memberships].sort())
    hash.update(lengthDelimited("group", membership));
  return hash.digest("hex");
}

export function scanSkillInstallSource(
  source: InstallHostSource,
  _options: BuildOptions,
): SkillInstallScan {
  const diagnostics: SkillDiagnostic[] = [];
  const canonicalSource = existingCanonical(source.canonicalPath);
  let sourceStat: Stats;
  try {
    sourceStat = statSync(canonicalSource);
  } catch {
    diagnostics.push({ path: canonicalSource, message: "source directory is not accessible" });
    return {
      sourceId: source.sourceId,
      displayCanonicalSourcePath: canonicalSource,
      scanRevision: createHash("sha256")
        .update(lengthDelimited("root", canonicalSource, "missing"))
        .digest("hex"),
      tree: [],
      defaultSelection: [],
      diagnostics,
    };
  }
  if (!sourceStat.isDirectory()) {
    diagnostics.push({ path: canonicalSource, message: "source is not a directory" });
    return {
      sourceId: source.sourceId,
      displayCanonicalSourcePath: canonicalSource,
      scanRevision: createHash("sha256")
        .update(lengthDelimited("root", canonicalSource, "file"))
        .digest("hex"),
      tree: [],
      defaultSelection: [],
      diagnostics,
    };
  }

  const root = {
    dir: canonicalSource,
    mode: "agents" as const,
    baseDir: dirname(canonicalSource),
    scope: "global" as const,
    source: "install" as const,
  };
  const skills = discoverSkillsFromRoot(root, diagnostics);
  const memberships = new Set<string>();
  for (const skill of skills) {
    const parts = treePath(skill, canonicalSource);
    for (let i = 1; i < parts.length; i++) memberships.add(parts.slice(0, i).join("/"));
  }
  const revision = buildRevision(canonicalSource, skills, [...memberships]);
  const tree: Array<SkillInstallGroup | SkillInstallCandidate> = [];
  const groups = new Map<string, SkillInstallGroup>();
  const ensureGroup = (pathParts: string[]): SkillInstallGroup => {
    const path = pathParts.join("/");
    const existing = groups.get(path);
    if (existing) return existing;
    const group: SkillInstallGroup = {
      kind: "group",
      id: opaqueId(source.candidateIdKey, source.sourceId, revision, "group", path),
      name: pathParts[pathParts.length - 1],
      children: [],
    };
    groups.set(path, group);
    if (pathParts.length === 1) tree.push(group);
    else {
      const parent = ensureGroup(pathParts.slice(0, -1));
      parent.children.push(group);
    }
    return group;
  };

  const defaultSelection: InstallCandidateSelection[] = [];
  for (const skill of [...skills].sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath))) {
    const parts = treePath(skill, canonicalSource);
    const id = opaqueId(
      source.candidateIdKey,
      source.sourceId,
      revision,
      "skill",
      skill.canonicalPath,
    );
    const candidate: SkillInstallCandidate = {
      kind: "skill",
      id,
      name: skill.name,
      description: skill.description,
      displayCanonicalPath: existingCanonical(skill.skillDir),
    };
    if (parts.length === 0) tree.push(candidate);
    else ensureGroup(parts).children.push(candidate);
    defaultSelection.push({ kind: "skill", id });
  }
  return {
    sourceId: source.sourceId,
    displayCanonicalSourcePath: canonicalSource,
    scanRevision: revision,
    tree,
    defaultSelection,
    diagnostics,
  };
}

export function selectionIds(scan: SkillInstallScan): Set<string> {
  const ids = new Set<string>();
  const visit = (nodes: Array<SkillInstallGroup | SkillInstallCandidate>) => {
    for (const node of nodes) {
      ids.add(node.id);
      if (node.kind === "group") visit(node.children);
    }
  };
  visit(scan.tree);
  return ids;
}

export function isInstallSelectionValid(
  scan: SkillInstallScan,
  selection: InstallCandidateSelection[],
): boolean {
  const ids = selectionIds(scan);
  return selection.length > 0 && selection.every((item) => ids.has(item.id));
}

function flattenCandidates(
  node: SkillInstallGroup | SkillInstallCandidate,
): SkillInstallCandidate[] {
  if (node.kind === "skill") return [node];
  return node.children.flatMap(flattenCandidates);
}

function nodeById(scan: SkillInstallScan): Map<string, SkillInstallGroup | SkillInstallCandidate> {
  const nodes = new Map<string, SkillInstallGroup | SkillInstallCandidate>();
  const visit = (items: Array<SkillInstallGroup | SkillInstallCandidate>) => {
    for (const item of items) {
      nodes.set(item.id, item);
      if (item.kind === "group") visit(item.children);
    }
  };
  visit(scan.tree);
  return nodes;
}

function settingsCustomDirectories(settingsPath: string): string[] {
  if (!existsSync(settingsPath)) return [];
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid YAML";
    throw new Error(`OMP config must be valid YAML: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OMP config must be a YAML object");
  }
  const skills = (parsed as { skills?: unknown }).skills;
  const customDirectories =
    skills && typeof skills === "object" && !Array.isArray(skills)
      ? (skills as { customDirectories?: unknown }).customDirectories
      : undefined;
  return Array.isArray(customDirectories)
    ? customDirectories.filter((item): item is string => typeof item === "string")
    : [];
}

function selectedCandidates(
  scan: SkillInstallScan,
  selection: InstallCandidateSelection[],
): SkillInstallCandidate[] {
  const nodes = nodeById(scan);
  const selected = new Map<string, SkillInstallCandidate>();
  for (const item of selection) {
    const node = nodes.get(item.id);
    if (!node || node.kind !== item.kind) throw new Error("Invalid skill install selection");
    for (const candidate of flattenCandidates(node)) {
      selected.set(candidate.displayCanonicalPath, candidate);
    }
  }
  return [...selected.values()];
}

function customRootsForSelection(
  scan: SkillInstallScan,
  selection: InstallCandidateSelection[],
): string[] {
  const candidates = selectedCandidates(scan, selection);
  const selectedPaths = new Set(candidates.map((candidate) => candidate.displayCanonicalPath));
  const allCandidates = [...nodeById(scan).values()].filter(
    (node): node is SkillInstallCandidate => node.kind === "skill",
  );
  const roots = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.displayCanonicalPath === scan.displayCanonicalSourcePath) {
      throw new Error(
        "OMP custom directories load direct child skills; select the parent directory instead",
      );
    }
    const root = dirname(candidate.displayCanonicalPath);
    const siblings = allCandidates.filter((other) => dirname(other.displayCanonicalPath) === root);
    if (siblings.some((sibling) => !selectedPaths.has(sibling.displayCanonicalPath))) {
      throw new Error(
        "OMP custom directories load every direct child skill; select all sibling skills under the directory",
      );
    }
    roots.add(root);
  }
  return [...roots].sort();
}

/**
 * Convert the selected candidates to OMP custom roots. OMP scans only direct
 * child directories, so partial sibling selections are rejected instead of
 * silently authorizing unselected siblings.
 */
export function buildSkillInstallPreview(
  scan: SkillInstallScan,
  scope: "global" | "project",
  selection: InstallCandidateSelection[],
  context: BuildOptions,
): SkillInstallPreview {
  if (scope === "project" && !context.projectTrusted) {
    throw new Error("Project is not trusted");
  }
  if (!isInstallSelectionValid(scan, selection)) {
    throw new Error("Invalid skill install selection");
  }
  const baseDir = canonicalizePath(
    scope === "global" ? context.agentDir : join(context.cwd, ".omp"),
  );
  const settingsPath = join(baseDir, "config.yml");
  const selectedPaths = customRootsForSelection(scan, selection);
  const existing = settingsCustomDirectories(settingsPath);
  const configuredCanonicalPaths = new Set(
    existing.map((entry) => existingCanonicalPath(entry, context.cwd)),
  );
  const additions: string[] = [];
  const skippedEntries: string[] = [];
  for (const selectedPath of [...selectedPaths].sort()) {
    const canonical = existingCanonicalPath(selectedPath, context.cwd);
    if (configuredCanonicalPaths.has(canonical)) {
      skippedEntries.push(selectedPath);
      continue;
    }
    additions.push(selectedPath);
  }
  return { scope, settingsPath, additions, skippedEntries };
}

function existingCanonicalPath(entry: string, baseDir: string): string {
  const target = resolve(baseDir, entry);
  return canonicalizeExistingPath(target);
}

export async function installSkillLinks(options: {
  source: InstallHostSource;
  scope: "global" | "project";
  scanRevision: string;
  selection: InstallCandidateSelection[];
  context: BuildOptions;
}): Promise<SkillInstallResult> {
  const { source, scope, scanRevision, selection, context } = options;
  if (scope === "project" && !context.projectTrusted) {
    throw new Error("Project is not trusted");
  }
  const baseDir = canonicalizePath(
    scope === "global" ? context.agentDir : join(context.cwd, ".omp"),
  );
  const settingsPath = join(baseDir, "config.yml");
  // The expensive rescan (recursive directory walk + per-skill content hash)
  // runs OUTSIDE the settings lock so it cannot keep the lock held long
  // enough for a stale-lock takeover to delete a still-live lock. The
  // freshness check (revision === scanRevision) is content-addressed, so a
  // source that changed between the user's scan and install is still rejected.
  // The in-lock work is limited to read → preview → merge → atomic write.
  const freshScan = scanSkillInstallSource(source, context);
  if (freshScan.scanRevision !== scanRevision || freshScan.sourceId !== source.sourceId) {
    throw new Error("Skill install source changed; rescan and confirm again");
  }
  const preview = buildSkillInstallPreview(freshScan, scope, selection, context);
  if (preview.additions.length > 0) {
    await updateYamlConfig(settingsPath, (config) => {
      const skills =
        config.skills && typeof config.skills === "object" && !Array.isArray(config.skills)
          ? (config.skills as Record<string, unknown>)
          : {};
      const current = Array.isArray(skills.customDirectories)
        ? skills.customDirectories.filter((entry): entry is string => typeof entry === "string")
        : [];
      skills.customDirectories = [...current, ...preview.additions];
      config.skills = skills;
    });
  }
  return {
    scan: freshScan,
    addedEntries: preview.additions,
    skippedEntries: preview.skippedEntries,
    settingsChanged: preview.additions.length > 0,
    runtimeRestartRequired: true,
  };
}
