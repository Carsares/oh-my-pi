// ABOUTME: Tests the accessible shell coordinating the Skills setting tabs.
// ABOUTME: Verifies tab order, keyboard selection, lazy activation, and persistent panels.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupSkillsTabShell } from "./skills-tab-shell.js";

function createTab(name, active = false) {
  const tab = document.createElement("button");
  tab.dataset.skillsPageTab = name;
  if (active) tab.classList.add("active");
  return tab;
}

describe("Skills tab shell", () => {
  let tabs;
  let panels;
  let activate;

  beforeEach(() => {
    tabs = [
      createTab("catalog", true),
      createTab("collections"),
      createTab("session"),
      createTab("install"),
    ];
    document.body.replaceChildren(...tabs);
    panels = Object.fromEntries(
      tabs.map((tab) => [tab.dataset.skillsPageTab, document.createElement("section")]),
    );
    activate = vi.fn();
  });

  it("selects tabs with roving tabindex and lazy activation", () => {
    setupSkillsTabShell({ tabs, panels, activate });
    expect(activate).not.toHaveBeenCalled();
    tabs[1].click();
    expect(activate).toHaveBeenCalledWith("collections");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].tabIndex).toBe(-1);
    expect(tabs[1].tabIndex).toBe(0);
    expect(panels.catalog.classList.contains("hidden")).toBe(true);
    expect(panels.collections.classList.contains("hidden")).toBe(false);
  });

  it("moves through the exact four-tab order with keyboard navigation", () => {
    setupSkillsTabShell({ tabs, panels, activate });
    tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(activate).toHaveBeenCalledWith("collections");
    tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(activate).toHaveBeenLastCalledWith("install");
    expect(document.activeElement).toBe(tabs[3]);
  });
});
