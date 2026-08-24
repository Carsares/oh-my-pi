// ABOUTME: Verifies the focused Discovered Skills tab keeps inventory ownership behavior.
// ABOUTME: Covers activation and trust state exposure.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n.js", () => ({
  onLocaleChange: () => () => {},
  t: (key) => key,
}));

import { setupDiscoveredSkillsTab } from "./skills-discovered-tab.js";

function inventory(overrides = {}) {
  return {
    trusted: true,
    roots: [
      {
        sourceRoot: "/home/.pi/agent/skills",
        scope: "user",
        rootKind: "pi",
        children: [
          { kind: "skill", id: "skill", name: "review", description: "review", status: "enabled" },
        ],
      },
    ],
    customRules: [],
    diagnostics: [],
    ...overrides,
  };
}

describe("Discovered Skills tab", () => {
  let container;
  beforeEach(() => {
    container = document.createElement("div");
  });

  it("loads inventory and exposes trust state", async () => {
    const rpcCommand = vi.fn().mockResolvedValue({ success: true, data: inventory() });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();
    expect(rpcCommand).toHaveBeenCalledWith({ type: "list_skill_inventory", scope: "global" });
    expect(tab.isProjectTrusted()).toBe(true);
  });

  it("renders skill roots without an add-root button", async () => {
    const rpcCommand = vi.fn().mockResolvedValue({ success: true, data: inventory() });
    const tab = setupDiscoveredSkillsTab({ container, rpcCommand });
    await tab.activate();
    expect(container.querySelector(".skills-add-root")).toBeNull();
    expect(container.querySelector(".skills-root")).toBeTruthy();
  });
});
