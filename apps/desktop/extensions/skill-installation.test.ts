// ABOUTME: Locks the authenticated skill install scanner's tree, preview, and revision semantics.
// ABOUTME: Verifies opaque IDs, nested groups, selected-root handling, and stale revisions.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

vi.mock("@oh-my-pi/pi-utils/file-lock", () => ({
  withFileLock: async (_path, critical) => await critical(),
}));
vi.mock("@oh-my-pi/pi-coding-agent/discovery", () => ({
  loadCapability: vi.fn(async () => ({ items: [], all: [], warnings: [], providers: [] })),
}));
vi.mock("@oh-my-pi/pi-coding-agent/discovery/helpers", () => ({
  scanSkillsFromDir: vi.fn(async () => ({ items: [], warnings: [] })),
}));

import {
  buildSkillInstallPreview,
  type InstallHostSource,
  installSkillLinks,
  isInstallSelectionValid,
  scanSkillInstallSource,
  selectionIds,
} from "./skill-installation.ts";

function fixture() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "picot-install-"));
  mkdirSync(join(root, "review", "nested"), { recursive: true });
  mkdirSync(join(root, "summarize"), { recursive: true });
  writeFileSync(
    join(root, "review", "SKILL.md"),
    "---\nname: review\ndescription: review\n---\nbody\n",
  );
  writeFileSync(
    join(root, "summarize", "SKILL.md"),
    "---\nname: summarize\ndescription: summarize\n---\nbody\n",
  );
  writeFileSync(join(root, "review", "nested", "ignored.md"), "not a skill\n");
  return root;
}

function source(root: string): InstallHostSource {
  return { sourceId: "source-opaque", canonicalPath: root, candidateIdKey: "app-secret" };
}

function options(root: string) {
  return { cwd: root, agentDir: join(root, ".omp", "agent"), projectTrusted: true };
}

describe("scanSkillInstallSource", () => {
  it("discovers nested skills and emits opaque stable IDs", () => {
    const root = fixture();
    const first = scanSkillInstallSource(source(root), options(root));
    const second = scanSkillInstallSource(source(root), options(root));
    expect(first.tree).toHaveLength(2);
    expect(first.scanRevision).toBe(second.scanRevision);
    expect(first.defaultSelection).toEqual(second.defaultSelection);
    expect(first.defaultSelection.every(({ id }) => !id.includes(root))).toBe(true);
    expect(selectionIds(first)).toEqual(
      new Set([
        ...first.tree.map((node) => node.id),
        ...first.tree.flatMap((node) =>
          node.kind === "group" ? node.children.map((child) => child.id) : [],
        ),
      ]),
    );
  });

  it("changes revision and IDs when a candidate body changes", () => {
    const root = fixture();
    const before = scanSkillInstallSource(source(root), options(root));
    writeFileSync(
      join(root, "review", "SKILL.md"),
      "---\nname: review\ndescription: review\n---\nchanged\n",
    );
    const after = scanSkillInstallSource(source(root), options(root));
    expect(after.scanRevision).not.toBe(before.scanRevision);
    expect(after.defaultSelection).not.toEqual(before.defaultSelection);
  });

  it("handles a source whose root itself is a skill", () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "picot-single-"));
    writeFileSync(join(root, "SKILL.md"), "---\nname: single\ndescription: one\n---\nbody\n");
    const scan = scanSkillInstallSource(source(root), options(root));
    expect(scan.tree).toHaveLength(1);
    expect(scan.tree[0].kind).toBe("skill");
    expect(scan.defaultSelection).toHaveLength(1);
  });

  it("reports invalid selections and deduplicates symlinked roots by canonical path", () => {
    const root = fixture();
    const alias = `${root}-alias`;
    symlinkSync(root, alias);
    const scan = scanSkillInstallSource(source(alias), options(root));
    expect(isInstallSelectionValid(scan, scan.defaultSelection)).toBe(true);
    expect(isInstallSelectionValid(scan, [{ kind: "skill", id: "unknown" }])).toBe(false);
  });
});

describe("installSkillLinks", () => {
  it("writes all selected entries atomically and remains idempotent", async () => {
    const root = fixture();
    const context = options(root);
    const scan = scanSkillInstallSource(source(root), context);
    const result = await installSkillLinks({
      source: source(root),
      scope: "global",
      scanRevision: scan.scanRevision,
      selection: scan.defaultSelection,
      context,
    });
    expect(result.settingsChanged).toBe(true);
    expect(result.addedEntries).toHaveLength(1);
    const settingsPath = join(root, ".omp", "agent", "config.yml");
    expect(parseYaml(readFileSync(settingsPath, "utf8"))).toEqual({
      skills: { customDirectories: [realpathSync(root)] },
    });
    const firstText = readFileSync(settingsPath, "utf8");
    const repeated = await installSkillLinks({
      source: source(root),
      scope: "global",
      scanRevision: result.scan.scanRevision,
      selection: result.scan.defaultSelection,
      context,
    });
    expect(repeated.settingsChanged).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe(firstText);
  });

  it("rejects a stale revision without creating settings", async () => {
    const root = fixture();
    const context = options(root);
    const scan = scanSkillInstallSource(source(root), context);
    writeFileSync(
      join(root, "review", "SKILL.md"),
      "---\nname: review\ndescription: review\n---\nchanged\n",
    );
    await expect(
      installSkillLinks({
        source: source(root),
        scope: "global",
        scanRevision: scan.scanRevision,
        selection: scan.defaultSelection,
        context,
      }),
    ).rejects.toThrow(/rescan/);
    expect(() => readFileSync(join(root, ".omp", "agent", "config.yml"))).toThrow();
  });
});

describe("buildSkillInstallPreview", () => {
  it("reduces a complete direct-sibling selection to one absolute OMP custom root", () => {
    const root = fixture();
    const scan = scanSkillInstallSource(source(root), options(root));
    const preview = buildSkillInstallPreview(scan, "global", scan.defaultSelection, options(root));
    expect(preview.additions).toEqual([realpathSync(root)]);
    expect(preview.settingsPath).toBe(join(realpathSync(root), ".omp", "agent", "config.yml"));
  });

  it("rejects partial direct-sibling selection because OMP would load unselected siblings", () => {
    const root = fixture();
    const scan = scanSkillInstallSource(source(root), options(root));
    const selected = scan.defaultSelection.find((item) => item.kind === "skill");
    if (!selected) throw new Error("expected skill");
    expect(() => buildSkillInstallPreview(scan, "project", [selected], options(root))).toThrow(
      /all sibling skills/,
    );
  });

  it("rejects unknown selections and untrusted project preview", () => {
    const root = fixture();
    const scan = scanSkillInstallSource(source(root), options(root));
    expect(() =>
      buildSkillInstallPreview(scan, "global", [{ kind: "skill", id: "nope" }], options(root)),
    ).toThrow(/selection/);
    expect(() =>
      buildSkillInstallPreview(scan, "project", scan.defaultSelection, {
        ...options(root),
        projectTrusted: false,
      }),
    ).toThrow(/trusted/);
  });

  it("treats OMP skills.customDirectories as already configured", () => {
    const root = realpathSync(fixture());
    const opts = { cwd: root, agentDir: join(root, ".omp", "agent"), projectTrusted: true };
    const settingsPath = join(opts.agentDir, "config.yml");
    mkdirSync(opts.agentDir, { recursive: true });
    writeFileSync(
      settingsPath,
      stringifyYaml({ skills: { enableSkillCommands: false, customDirectories: [root] } }),
    );
    const scan = scanSkillInstallSource(source(root), opts);
    const preview = buildSkillInstallPreview(scan, "global", scan.defaultSelection, opts);
    expect(preview.additions).toEqual([]);
    expect(preview.skippedEntries).toHaveLength(1);
  });

  it("rejects selecting a source that is itself a skill", () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "picot-single-"));
    writeFileSync(join(root, "SKILL.md"), "---\nname: single\ndescription: one\n---\nbody\n");
    const scan = scanSkillInstallSource(source(root), options(root));
    expect(() =>
      buildSkillInstallPreview(scan, "global", scan.defaultSelection, options(root)),
    ).toThrow(/parent directory/);
  });
});
