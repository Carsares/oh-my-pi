import { afterEach, describe, expect, it, vi } from "vitest";
import { setupSkillsCatalogPanel } from "./skills-catalog-panel.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Skills Catalog panel", () => {
  it("renders OMP catalog entries and uses native rescan data", async () => {
    document.body.innerHTML = '<div id="catalog"></div>';
    const first = {
      revision: 1,
      entries: [
        {
          skillId: "skill-a",
          name: "Review",
          description: "Review changes",
          status: "available",
          canonicalPath: "/skills/review",
          sources: [{ providerId: "user", level: "user", discoveryKind: "standard" }],
        },
        {
          skillId: "skill-b",
          name: "Review",
          description: "Review another source",
          status: "available",
          canonicalPath: "/project/skills/review/SKILL.md",
          sources: [{ providerId: "project", level: "project", discoveryKind: "standard" }],
        },
      ],
    };
    const rescanned = { revision: 2, entries: [{ ...first.entries[0], status: "missing" }] };
    const client = {
      catalogList: vi.fn(async () => first),
      catalogRescan: vi.fn(async () => rescanned),
      catalogGet: vi.fn(async () => first.entries[0]),
    };
    const panel = setupSkillsCatalogPanel({
      container: document.getElementById("catalog"),
      client,
    });

    await panel.activate();
    expect(document.body.textContent).not.toContain("null");
    expect(document.body.textContent).toContain("Review changes");
    expect(document.body.textContent).toContain("/skills/review");
    expect(document.body.textContent).toContain("settings.skills.sameNamePaths");
    const entry = document.querySelector('[data-skill-id="skill-a"]');
    expect(entry).not.toBeNull();
    expect(entry.querySelector(".skill-management-member-header strong").textContent).toBe(
      "Review",
    );
    expect(entry.querySelector(".skill-management-member-path").textContent).toBe("/skills/review");
    expect(entry.querySelector(".skill-management-member-description").title).toBe(
      "Review changes",
    );

    document.querySelector(".skills-rescan, .skill-management-toolbar .ui-button").click();
    await vi.waitFor(() => expect(client.catalogRescan).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(document.body.textContent).toContain("missing"));
  });
});
