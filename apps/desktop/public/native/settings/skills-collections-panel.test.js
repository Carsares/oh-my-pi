import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupSkillsCollectionsPanel } from "./skills-collections-panel.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Skills Collections panel", () => {
  it("keeps member rows at their natural height inside the scrollable list", () => {
    const css = readFileSync(
      resolve(process.cwd(), "public/native/settings/skills-management.css"),
      "utf8",
    );
    const memberRule =
      [...css.matchAll(/\.skill-collection-member-option\s*\{([^}]*)\}/g)]
        .map((match) => match[1])
        .find((body) => body.includes("display: grid")) ?? "";
    expect(memberRule).toContain("flex: 0 0 auto");
  });

  it("creates a collection with the latest revision and selects the server-issued ID", async () => {
    document.body.innerHTML = '<div id="collections"></div>';
    const state = {
      state: { schemaVersion: 1, revision: 4, defaultCollectionId: "local-all", collections: [] },
      collections: [
        { collectionId: "local-all", name: "All", virtual: true, skillIds: ["skill-a"] },
      ],
    };
    let created = false;
    const client = {
      collectionsList: vi.fn(async () =>
        created
          ? {
              state: {
                ...state.state,
                revision: 5,
                collections: [
                  {
                    collectionId: "server-collection",
                    name: "My skills",
                    skillIds: ["skill-a", "skill-b"],
                  },
                ],
              },
              collections: [
                ...state.collections,
                {
                  collectionId: "server-collection",
                  name: "My skills",
                  skillIds: ["skill-a", "skill-b"],
                },
              ],
            }
          : state,
      ),
      catalogList: vi.fn(async () => ({
        entries: [
          {
            skillId: "skill-a",
            name: "Review",
            description: "Review changes",
            status: "available",
            eligibility: "eligible",
          },
          {
            skillId: "skill-b",
            name: "Review",
            description: "Review another source",
            status: "available",
            eligibility: "eligible",
          },
        ],
      })),
      collectionGet: vi.fn(async (collectionId) => ({
        collection:
          collectionId === "server-collection"
            ? { collectionId, name: "My skills", skillIds: ["skill-a", "skill-b"] }
            : state.collections[0],
      })),
      collectionCreate: vi.fn(async () => {
        created = true;
        return { collection: { collectionId: "server-collection" } };
      }),
    };
    const panel = setupSkillsCollectionsPanel({
      container: document.getElementById("collections"),
      client,
    });
    await panel.activate();

    expect(document.querySelector(".skill-collection-detail h3").textContent).toBe(
      "settings.skills.localAll",
    );
    expect(document.querySelector(".skill-collection-detail p").textContent).toBe(
      "settings.skills.localAllDescription",
    );

    const newButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent.includes("settings.skills.newCollection"),
    );
    newButton.click();
    const name = document.querySelector(".skill-collection-editor input.ui-input");
    name.value = "My skills";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const members = document.querySelectorAll('.skill-collection-editor input[type="checkbox"]');
    expect(document.querySelectorAll(".skill-collection-member-option")).toHaveLength(2);
    expect(document.querySelectorAll(".skill-collection-member-description")).toHaveLength(2);
    expect(document.body.textContent).toContain("Review changes");
    members[0].click();
    document.querySelectorAll('.skill-collection-editor input[type="checkbox"]')[1].click();
    expect(document.body.textContent).toContain("settings.skills.collectionConflictSummary");
    const save = [...document.querySelectorAll("button")].find((button) =>
      button.textContent.includes("settings.skills.saveCollection"),
    );
    save.click();

    await vi.waitFor(() => expect(client.collectionCreate).toHaveBeenCalledOnce());
    expect(client.collectionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "My skills",
        skillIds: ["skill-a", "skill-b"],
        expectedRevision: 4,
      }),
    );
    await vi.waitFor(() =>
      expect(client.collectionGet).toHaveBeenLastCalledWith("server-collection"),
    );
  });
});
