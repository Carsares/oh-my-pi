import { afterEach, describe, expect, it, vi } from "vitest";
import { setupSessionSkillsPanel } from "./skills-session-panel.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function createState() {
  return {
    activeLeafId: "leaf-a",
    profile: {
      schemaVersion: 2,
      revision: 3,
      updatedAt: "2026-08-26T00:00:00Z",
      baseCollection: {
        collectionId: "local-all",
        collectionName: "All",
        skillIds: ["skill-a", "skill-b", "skill-c"],
      },
      additionalCollections: [
        {
          collectionId: "tools",
          collectionName: "Tools",
          skillIds: ["skill-d", "skill-e"],
        },
      ],
      addedSkillIds: ["skill-b"],
      disabledSkillIds: ["skill-c"],
    },
    memberStates: [
      {
        skillId: "skill-a",
        availability: "available",
        eligibility: "eligible",
        runtimeStatus: "active",
        reasons: [],
      },
      {
        skillId: "skill-b",
        availability: "available",
        eligibility: "eligible",
        runtimeStatus: "shadowed",
        reasons: ["same name"],
      },
      {
        skillId: "skill-c",
        availability: "available",
        eligibility: "eligible",
        runtimeStatus: "disabled",
        reasons: [],
      },
      {
        skillId: "skill-d",
        availability: "available",
        eligibility: "eligible",
        runtimeStatus: "inactive",
        reasons: [],
      },
      {
        skillId: "skill-e",
        availability: "missing",
        eligibility: "blocked",
        runtimeStatus: "inactive",
        reasons: ["source missing"],
      },
    ],
    resolved: {
      activeSkillIds: ["skill-a"],
      resolutions: [
        {
          name: "Review",
          activeSkillId: "skill-a",
          candidateSkillIds: ["skill-a", "skill-b"],
          shadowedSkillIds: ["skill-b"],
        },
      ],
      diagnostics: [],
    },
  };
}

function catalogEntries() {
  return [
    {
      skillId: "skill-a",
      name: "Review A",
      description: "Review active skill",
      canonicalPath: "/home/me/.agents/skills/review-a/SKILL.md",
      effectiveSource: { providerId: "agents", level: "user", discoveryKind: "standard" },
    },
    {
      skillId: "skill-b",
      name: "Review B",
      description: "Review shadowed skill",
      canonicalPath: "/project/.omp/skills/review-b/SKILL.md",
      effectiveSource: { providerId: "native", level: "project", discoveryKind: "standard" },
    },
    {
      skillId: "skill-c",
      name: "Deploy",
      description: "Deploy helper",
      canonicalPath: "/home/me/.agents/skills/deploy/SKILL.md",
      effectiveSource: { providerId: "agents", level: "user", discoveryKind: "standard" },
    },
    {
      skillId: "skill-d",
      name: "Docs",
      description: "Document helper",
      canonicalPath: "/home/me/.agents/skills/docs/SKILL.md",
      effectiveSource: { providerId: "agents", level: "user", discoveryKind: "standard" },
    },
    {
      skillId: "skill-e",
      name: "Legacy",
      description: "Missing helper",
      canonicalPath: "/home/me/.agents/skills/legacy/SKILL.md",
      effectiveSource: { providerId: "agents", level: "user", discoveryKind: "standard" },
    },
    {
      skillId: "skill-f",
      name: "Release notes",
      description: "Create release notes",
      canonicalPath: "/home/me/.agents/skills/release-notes/SKILL.md",
      effectiveSource: { providerId: "agents", level: "user", discoveryKind: "standard" },
    },
  ];
}

function createClient(overrides = {}) {
  return {
    sessionGet: vi.fn(async () => createState()),
    collectionsList: vi.fn(async () => ({
      state: { revision: 6, defaultCollectionId: "local-all", collections: [] },
      collections: [
        { collectionId: "local-all", name: "All", skillIds: ["skill-a", "skill-b", "skill-c"] },
        { collectionId: "tools", name: "Tools", skillIds: ["skill-d", "skill-e"] },
        { collectionId: "focused", name: "Focused", skillIds: ["skill-a"] },
      ],
    })),
    catalogList: vi.fn(async () => ({ entries: catalogEntries() })),
    sessionSetBaseCollection: vi.fn(async () => createState()),
    sessionAddCollection: vi.fn(async () => createState()),
    sessionRemoveCollection: vi.fn(async () => createState()),
    sessionAdd: vi.fn(async () => createState()),
    sessionDisable: vi.fn(async () => createState()),
    sessionRestore: vi.fn(async () => createState()),
    sessionActivate: vi.fn(async () => createState()),
    sessionSyncPreview: vi.fn(async () => ({
      profileRevision: 3,
      collectionsRevision: 6,
      catalogRevision: 8,
      addedSkillIds: ["skill-f"],
      removedSkillIds: ["skill-c"],
      newConflictNames: ["Review"],
      winnerChanges: [{ name: "Review", previousSkillId: "skill-a", nextSkillId: "skill-b" }],
    })),
    sessionSync: vi.fn(async () => createState()),
    sessionRefresh: vi.fn(async () => createState()),
    ...overrides,
  };
}

function mount(client = createClient(), options = {}) {
  document.body.innerHTML = `
    <div class="settings-content">
      <div id="session-skills"></div>
    </div>
  `;
  const panel = setupSessionSkillsPanel({
    container: document.getElementById("session-skills"),
    client,
    ...options,
  });
  return { panel, client, scroller: document.querySelector(".settings-content") };
}

describe("Session Skills panel", () => {
  it("treats every selected collection as removable and only adds an unselected collection", async () => {
    const { panel, client } = mount();
    await panel.activate();

    const sourcePanel = document.querySelector(".skill-session-sources");
    expect(sourcePanel.textContent).toContain("All");
    expect(sourcePanel.textContent).toContain("Tools");
    expect(sourcePanel.querySelectorAll(".skill-session-source-label")).toHaveLength(0);
    expect(
      sourcePanel.querySelectorAll(".skill-session-source-list .skill-session-source-row"),
    ).toHaveLength(2);
    expect(document.querySelector(".skill-session-layout")).not.toBeNull();

    const removeButtons = sourcePanel.querySelectorAll("[data-session-remove-collection]");
    expect([...removeButtons].map((button) => button.dataset.collectionId)).toEqual([
      "local-all",
      "tools",
    ]);
    removeButtons[0].click();
    await vi.waitFor(() =>
      expect(client.sessionRemoveCollection).toHaveBeenNthCalledWith(1, {
        expectedActiveLeafId: "leaf-a",
        expectedRevision: 3,
        collectionId: "local-all",
      }),
    );

    let toolsRemove;
    await vi.waitFor(() => {
      toolsRemove = document.querySelector(
        '[data-session-remove-collection][data-collection-id="tools"]',
      );
      expect(toolsRemove.disabled).toBe(false);
    });
    toolsRemove.click();
    await vi.waitFor(() =>
      expect(client.sessionRemoveCollection).toHaveBeenNthCalledWith(2, {
        expectedActiveLeafId: "leaf-a",
        expectedRevision: 3,
        collectionId: "tools",
      }),
    );
    expect(client.sessionSetBaseCollection).not.toHaveBeenCalled();

    let refreshedSourcePanel;
    await vi.waitFor(() => {
      refreshedSourcePanel = document.querySelector(".skill-session-sources");
      expect(refreshedSourcePanel.querySelector("[data-session-remove-collection]").disabled).toBe(
        false,
      );
    });
    const addCollection = [...refreshedSourcePanel.querySelectorAll("button")].find((button) =>
      button.textContent.includes("settings.skills.addCollection"),
    );
    addCollection.click();
    const addEditor = document.querySelector("[data-session-collection-editor]");
    const addSelect = addEditor.querySelector("[data-session-add-collection]");
    const confirmAdd = [...addEditor.querySelectorAll("button")].find((button) =>
      button.textContent.includes("settings.skills.addCollection"),
    );
    expect(addEditor.hidden).toBe(false);
    expect(confirmAdd.disabled).toBe(true);
    expect([...addSelect.options].map((option) => option.value)).toEqual(["", "focused"]);

    addSelect.value = "focused";
    addSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(confirmAdd.disabled).toBe(false);
    confirmAdd.click();
    await vi.waitFor(() =>
      expect(client.sessionAddCollection).toHaveBeenCalledWith({
        expectedActiveLeafId: "leaf-a",
        expectedRevision: 3,
        collectionId: "focused",
      }),
    );
    panel.destroy();
  });

  it("shows an actionable empty state when the session has no selected collections", async () => {
    const emptyState = createState();
    emptyState.profile.baseCollection = null;
    emptyState.profile.additionalCollections = [];
    emptyState.profile.addedSkillIds = [];
    emptyState.profile.disabledSkillIds = [];
    emptyState.memberStates = [];
    emptyState.resolved = { activeSkillIds: [], resolutions: [], diagnostics: [] };
    const client = createClient({ sessionGet: vi.fn(async () => emptyState) });
    const { panel } = mount(client);

    await panel.activate();

    const sources = document.querySelector(".skill-session-sources");
    expect(sources.querySelector("[data-session-collections-empty]").textContent).toBe(
      "settings.skills.noCollectionsSelected",
    );
    expect(sources.querySelectorAll("[data-session-remove-collection]")).toHaveLength(0);
    expect(
      [...sources.querySelectorAll("button")].some((button) =>
        button.textContent.includes("settings.skills.addCollection"),
      ),
    ).toBe(true);
    panel.destroy();
  });

  it("filters and expands grouped members without rebuilding the list or losing scroll position", async () => {
    const { panel, scroller } = mount();
    await panel.activate();
    scroller.scrollTop = 120;

    const active = document.querySelector('[data-skill-id="skill-a"]');
    const shadowed = document.querySelector('[data-skill-id="skill-b"]');
    expect(document.querySelectorAll("[data-session-member-group]")).toHaveLength(5);
    expect(shadowed.textContent).toContain("settings.skills.manualAddition");

    document.querySelector('[data-session-status-filter="shadowed"]').click();
    expect(document.querySelector('[data-session-member-group="active"]').hidden).toBe(true);
    expect(document.querySelector('[data-session-member-group="shadowed"]').hidden).toBe(false);
    expect(document.querySelector('[data-skill-id="skill-b"]')).toBe(shadowed);
    expect(scroller.scrollTop).toBe(120);

    const search = document.querySelector('.skill-session-search input[type="search"]');
    search.value = "Review A";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector("[data-session-member-empty]").hidden).toBe(false);

    document.querySelector('[data-session-status-filter="all"]').click();
    expect(active.hidden).toBe(false);
    expect(document.querySelector("[data-session-member-empty]").hidden).toBe(true);

    const expand = active.querySelector(".skill-session-expand");
    expand.click();
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(active.querySelector(".skill-session-member-details").hidden).toBe(false);
    expect(active.textContent).toContain(".../skills/review-a/SKILL.md");
    expect(scroller.scrollTop).toBe(120);
    panel.destroy();
  });

  it("confirms the server-reported same-name impact before activating a shadowed Skill", async () => {
    const client = createClient();
    const { panel } = mount(client);
    await panel.activate();

    document.querySelector('[data-skill-id="skill-b"] [data-session-activate-skill]').click();

    const dialog = document.querySelector('[role="alertdialog"][data-session-dialog="activation"]');
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("settings.skills.activationDescription");
    expect(dialog.textContent).toContain("Review A");
    expect(client.sessionActivate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(dialog.querySelector("[data-session-dialog-primary]"));

    dialog.querySelector("[data-session-dialog-primary]").click();
    await vi.waitFor(() =>
      expect(client.sessionActivate).toHaveBeenCalledWith({
        expectedActiveLeafId: "leaf-a",
        expectedRevision: 3,
        skillId: "skill-b",
      }),
    );
    panel.destroy();
  });

  it("shows a revision-bound sync preview before applying collection snapshot changes", async () => {
    const client = createClient();
    const { panel } = mount(client);
    await panel.activate();

    document.querySelector("[data-session-sync]").click();
    await vi.waitFor(() => expect(client.sessionSyncPreview).toHaveBeenCalledWith());

    const dialog = document.querySelector('[role="dialog"][data-session-dialog="sync"]');
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("Release notes");
    expect(dialog.textContent).toContain("Deploy");
    expect(dialog.textContent).toContain("Review A -> Review B");
    expect(document.activeElement).toBe(dialog.querySelector("[data-session-dialog-primary]"));

    dialog.querySelector("[data-session-dialog-primary]").click();
    await vi.waitFor(() =>
      expect(client.sessionSync).toHaveBeenCalledWith({
        expectedActiveLeafId: "leaf-a",
        expectedRevision: 3,
        previewRevisions: {
          expectedProfileRevision: 3,
          expectedCollectionsRevision: 6,
          expectedCatalogRevision: 8,
        },
      }),
    );
    panel.destroy();
  });

  it("reports an up-to-date profile without opening an empty sync dialog", async () => {
    const showSuccess = vi.fn();
    const client = createClient({
      sessionSyncPreview: vi.fn(async () => ({
        profileRevision: 3,
        collectionsRevision: 6,
        catalogRevision: 8,
        addedSkillIds: [],
        removedSkillIds: [],
        newConflictNames: [],
        winnerChanges: [],
      })),
    });
    const { panel } = mount(client, { showSuccess });
    await panel.activate();

    document.querySelector("[data-session-sync]").click();
    await vi.waitFor(() =>
      expect(showSuccess).toHaveBeenCalledWith("settings.skills.syncUpToDate"),
    );
    expect(document.querySelector("[data-session-dialog]")).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("[data-session-sync]"));
    panel.destroy();
  });
});
