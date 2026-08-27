import { afterEach, describe, expect, it, vi } from "vitest";
import { setupSessionSkillsPanel } from "./skills-session-panel.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function createState() {
  return {
    activeLeafId: "leaf-a",
    profile: {
      revision: 3,
      updatedAt: "2026-08-26T00:00:00Z",
      baseCollection: {
        collectionId: "local-all",
        collectionName: "All",
        skillIds: ["skill-a", "skill-b"],
      },
      additionalCollections: [],
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

describe("Session Skills panel", () => {
  it("exposes collection menus and enables actions only after a valid selection", async () => {
    document.body.innerHTML = '<div id="session-skills"></div>';
    const client = {
      sessionGet: vi.fn(async () => createState()),
      collectionsList: vi.fn(async () => ({
        state: { revision: 6, defaultCollectionId: "local-all", collections: [] },
        collections: [
          { collectionId: "local-all", name: "All", skillIds: ["skill-a", "skill-b"] },
          { collectionId: "focused", name: "Focused", skillIds: ["skill-a"] },
        ],
      })),
      catalogList: vi.fn(async () => ({ entries: [] })),
    };
    const panel = setupSessionSkillsPanel({
      container: document.getElementById("session-skills"),
      client,
    });
    await panel.activate();

    const collectionPanel = document.querySelector(".skill-session-collections");
    const baseSelect = collectionPanel.querySelector("[data-session-base-collection]");
    const addSelect = collectionPanel.querySelector("[data-session-add-collection]");
    const [changeBaseButton, addCollectionButton] = collectionPanel.querySelectorAll(
      ".skill-management-form-row > .ui-button",
    );

    expect(collectionPanel.querySelectorAll('[role="combobox"]')).toHaveLength(2);
    expect(baseSelect.classList.contains("ui-select-native")).toBe(true);
    expect(addSelect.classList.contains("ui-select-native")).toBe(true);
    expect(changeBaseButton.disabled).toBe(true);
    expect(addCollectionButton.disabled).toBe(true);

    baseSelect.value = "focused";
    baseSelect.dispatchEvent(new Event("change", { bubbles: true }));
    addSelect.value = "focused";
    addSelect.dispatchEvent(new Event("change", { bubbles: true }));

    expect(changeBaseButton.disabled).toBe(false);
    expect(addCollectionButton.disabled).toBe(false);
    panel.destroy();
  });

  it("shows server winner states and sends activate plus revision-bound sync", async () => {
    document.body.innerHTML = '<div id="session-skills"></div>';
    const client = {
      sessionGet: vi.fn(async () => createState()),
      collectionsList: vi.fn(async () => ({
        state: { revision: 6, defaultCollectionId: "local-all", collections: [] },
        collections: [{ collectionId: "local-all", name: "All", skillIds: ["skill-a", "skill-b"] }],
      })),
      catalogList: vi.fn(async () => ({
        entries: [
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
        ],
      })),
      sessionActivate: vi.fn(async () => createState()),
      sessionSyncPreview: vi.fn(async () => ({
        profileRevision: 3,
        collectionsRevision: 6,
        catalogRevision: 8,
        addedSkillIds: ["skill-c"],
        removedSkillIds: [],
        newConflictNames: ["review"],
        winnerChanges: [],
      })),
      sessionSync: vi.fn(async () => createState()),
    };
    const panel = setupSessionSkillsPanel({
      container: document.getElementById("session-skills"),
      client,
    });
    await panel.activate();

    expect(document.body.textContent).not.toContain("null");
    expect(document.body.textContent).toContain("active");
    expect(document.body.textContent).toContain("shadowed");
    expect(document.body.textContent).toContain("settings.skills.sessionConflictCount");
    expect(document.body.textContent).toContain(".../skills/review-b/SKILL.md");
    const shadowed = document.querySelector('[data-skill-id="skill-b"]');
    expect(shadowed.querySelector(".skill-management-member-header strong").textContent).toBe(
      "Review B",
    );
    expect(shadowed.querySelector(".skill-management-member-description").title).toBe(
      "Review shadowed skill",
    );
    const activate = [...shadowed.querySelectorAll("button")].find((button) =>
      button.textContent.includes("settings.skills.activate"),
    );
    activate.click();
    await vi.waitFor(() =>
      expect(client.sessionActivate).toHaveBeenCalledWith({
        expectedActiveLeafId: "leaf-a",
        expectedRevision: 3,
        skillId: "skill-b",
      }),
    );
    let sync;
    await vi.waitFor(() => {
      expect(client.sessionGet).toHaveBeenCalledTimes(2);
      sync = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "settings.skills.sync" && !button.disabled,
      );
      expect(sync).toBeDefined();
    });
    sync.click();
    await vi.waitFor(() => expect(client.sessionSyncPreview).toHaveBeenCalledWith());
    const confirm = [...document.querySelectorAll("button")].find((button) =>
      button.textContent.includes("settings.skills.confirmSync"),
    );
    confirm.click();
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
  });
});
