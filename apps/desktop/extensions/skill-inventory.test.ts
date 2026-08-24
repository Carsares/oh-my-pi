// ABOUTME: Locks Picot's adapter to OMP skill discovery and config.yml enablement semantics.
// ABOUTME: Covers source filters, winner recomputation, exact IDs, trust, and YAML preservation.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const discovery = vi.hoisted(() => ({
  all: [] as Array<Record<string, unknown>>,
  warnings: [] as string[],
  custom: new Map<string, Array<Record<string, unknown>>>(),
}));

vi.mock("@oh-my-pi/pi-utils/file-lock", () => ({
  withFileLock: async (_path: string, critical: () => Promise<unknown>) => await critical(),
}));

vi.mock("@oh-my-pi/pi-coding-agent/discovery", () => ({
  loadCapability: vi.fn(async () => ({
    items: discovery.all,
    all: discovery.all,
    warnings: discovery.warnings,
    providers: [],
  })),
}));

vi.mock("@oh-my-pi/pi-coding-agent/discovery/helpers", () => ({
  scanSkillsFromDir: vi.fn(async (_context, options) => ({
    items: discovery.custom.get(options.dir) ?? [],
    warnings: [],
  })),
}));

import {
  buildSkillInventory,
  findSkillInRoots,
  mutateSkillEnabled,
  type SkillSettingsRuntime,
} from "./skill-inventory.ts";

const tempRoots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "picot-omp-skills-"));
  tempRoots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, agentDir, cwd };
}

function skill(
  root: string,
  name: string,
  source: { provider?: string; level?: "user" | "project" } = {},
) {
  const filePath = join(root, name, "SKILL.md");
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} description\n---\nbody\n`);
  return {
    name,
    path: filePath,
    content: "body",
    frontmatter: { name, description: `${name} description` },
    level: source.level ?? "user",
    _source: {
      provider: source.provider ?? "native",
      providerName: source.provider ?? "OMP",
      path: filePath,
      level: source.level ?? "user",
    },
  };
}

function options(values: ReturnType<typeof fixture>, scope: "global" | "project" = "global") {
  return {
    scope,
    cwd: values.cwd,
    agentDir: values.agentDir,
    homeDir: values.root,
    projectTrusted: true,
  } as const;
}

function allItems(inventory: Awaited<ReturnType<typeof buildSkillInventory>>) {
  return inventory.roots.flatMap((root) => root.children).filter((item) => item.kind === "skill");
}

beforeEach(() => {
  discovery.all = [];
  discovery.warnings = [];
  discovery.custom.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("buildSkillInventory", () => {
  it("adapts all OMP providers without copying harness path rules", async () => {
    const values = fixture();
    discovery.all = [
      skill(join(values.root, "native"), "omp", { provider: "native" }),
      skill(join(values.root, "claude"), "claude", { provider: "claude" }),
      skill(join(values.root, "codex"), "codex", { provider: "codex" }),
      skill(join(values.root, "plugin"), "plugin", { provider: "omp-plugins" }),
    ];
    const inventory = await buildSkillInventory(options(values));
    expect(
      allItems(inventory)
        .map((item) => item.name)
        .sort(),
    ).toEqual(["claude", "codex", "omp", "plugin"]);
    expect(inventory.settingsPath).toBe(join(values.agentDir, "config.yml"));
  });

  it("uses OMP source toggles, include/ignore patterns, and disabled extension IDs", async () => {
    const values = fixture();
    discovery.all = [
      skill(join(values.root, "claude"), "claude-one", { provider: "claude" }),
      skill(join(values.root, "codex"), "codex-one", { provider: "codex" }),
      skill(join(values.root, "native"), "native-one", { provider: "native" }),
    ];
    writeFileSync(
      join(values.agentDir, "config.yml"),
      stringifyYaml({
        disabledExtensions: ["skill:native-one"],
        skills: {
          enableClaudeUser: false,
          ignoredSkills: ["codex-*"],
          includeSkills: ["*-one"],
        },
      }),
    );
    const items = allItems(await buildSkillInventory(options(values)));
    expect(items.find((item) => item.name === "claude-one")?.matchingRules).toContain(
      "skills.claude=false",
    );
    expect(items.find((item) => item.name === "codex-one")?.matchingRules).toContain(
      "ignored:codex-one",
    );
    expect(items.find((item) => item.name === "native-one")?.matchingRules).toContain(
      "skill:native-one",
    );
    expect(items.every((item) => item.status === "disabled")).toBe(true);
  });

  it("recomputes same-name winners after disabled sources are filtered", async () => {
    const values = fixture();
    discovery.all = [
      skill(join(values.root, "claude"), "review", { provider: "claude" }),
      skill(join(values.root, "agents"), "review", { provider: "agents" }),
    ];
    writeFileSync(
      join(values.agentDir, "config.yml"),
      stringifyYaml({ skills: { enableClaudeUser: false } }),
    );
    const items = allItems(await buildSkillInventory(options(values)));
    expect(items.find((item) => item.sourceRoot.includes("claude"))?.status).toBe("disabled");
    expect(items.find((item) => item.sourceRoot.includes("agents"))?.status).toBe("enabled");
  });

  it("gives configured custom directories precedence over default providers", async () => {
    const values = fixture();
    const customRoot = join(values.root, "custom");
    discovery.all = [skill(join(values.root, "native"), "review", { provider: "native" })];
    discovery.custom.set(customRoot, [
      {
        ...skill(customRoot, "review"),
        _source: {
          provider: "custom",
          providerName: "Custom",
          path: join(customRoot, "review", "SKILL.md"),
          level: "user",
        },
      },
    ]);
    writeFileSync(
      join(values.agentDir, "config.yml"),
      stringifyYaml({ skills: { customDirectories: [customRoot] } }),
    );
    const items = allItems(await buildSkillInventory(options(values)));
    expect(items.find((item) => item.source === "local")?.status).toBe("enabled");
    expect(items.find((item) => item.source === "auto")?.status).toBe("shadowed");
  });

  it("does not expose project skill paths before project trust", async () => {
    const values = fixture();
    discovery.all = [
      skill(join(values.root, "project-secret"), "secret", {
        provider: "native",
        level: "project",
      }),
    ];
    const inventory = await buildSkillInventory({
      ...options(values, "project"),
      projectTrusted: false,
    });
    expect(inventory.roots).toEqual([]);
    expect(inventory.discoveredRoots).toEqual([join(values.cwd, ".omp", "skills")]);
  });
});

describe("mutateSkillEnabled", () => {
  it("writes exact skill:<name> IDs to OMP YAML and preserves unrelated fields", async () => {
    const values = fixture();
    discovery.all = [skill(join(values.root, "native"), "review", { provider: "native" })];
    const configPath = join(values.agentDir, "config.yml");
    writeFileSync(
      configPath,
      stringifyYaml({ unknown: { keep: true }, disabledExtensions: ["tool:x"] }),
    );
    const inventory = await buildSkillInventory(options(values));
    const item = allItems(inventory)[0];
    await mutateSkillEnabled({
      ...options(values),
      target: { kind: "skill", id: item.id },
      enabled: false,
    });
    expect(parseYaml(readFileSync(configPath, "utf8"))).toEqual({
      unknown: { keep: true },
      disabledExtensions: ["tool:x", "skill:review"],
    });
    const disabled = await buildSkillInventory(options(values));
    expect(findSkillInRoots(disabled.roots, item.id)?.status).toBe("disabled");
  });

  it("enables by removing only the exact OMP ID and reloads the active settings", async () => {
    const values = fixture();
    discovery.all = [skill(join(values.root, "native"), "review", { provider: "native" })];
    const configPath = join(values.agentDir, "config.yml");
    writeFileSync(
      configPath,
      stringifyYaml({ disabledExtensions: ["skill:review-other", "skill:review"] }),
    );
    let disabled = ["skill:review-other", "skill:review"];
    const runtime: SkillSettingsRuntime = {
      get: () => disabled,
      getGroup: () => ({}),
      flush: vi.fn(async () => undefined),
      reloadFromDisk: vi.fn(async () => {
        disabled = parseYaml(readFileSync(configPath, "utf8")).disabledExtensions;
      }),
    };
    const inventory = await buildSkillInventory({ ...options(values), settingsRuntime: runtime });
    const item = allItems(inventory)[0];
    await mutateSkillEnabled({
      ...options(values),
      settingsRuntime: runtime,
      target: { kind: "skill", id: item.id },
      enabled: true,
    });
    expect(parseYaml(readFileSync(configPath, "utf8")).disabledExtensions).toEqual([
      "skill:review-other",
    ]);
    expect(runtime.flush).toHaveBeenCalledOnce();
    expect(runtime.reloadFromDisk).toHaveBeenCalledOnce();
  });

  it("rejects group mutations because OMP persists skill IDs, not path groups", async () => {
    const values = fixture();
    await expect(
      mutateSkillEnabled({
        ...options(values),
        target: { kind: "group", id: "group" },
        enabled: false,
      }),
    ).rejects.toThrow(/groups/);
  });
});
