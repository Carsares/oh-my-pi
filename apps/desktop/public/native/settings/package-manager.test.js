import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n.js";
import { normalizeSource, setupPackageManager } from "./package-manager.js";

function renderManagerDom() {
  document.body.innerHTML = `
    <div class="settings-tab" data-settings-panel="extensions">
      <div class="settings-section" id="pkg-manager-section">
        <div class="pkg-manager-shell">
          <div class="pkg-manager-sidebar">
            <div id="pkg-manager-groups" class="pkg-manager-groups"></div>
            <button type="button" id="pkg-manager-add-btn">+ Add plugin</button>
          </div>
          <div id="pkg-manager-detail" class="pkg-manager-detail"></div>
        </div>
        <div id="pkg-manager-footer" class="pkg-manager-footer"></div>
      </div>
      <div class="settings-section" id="pkg-browse-section" hidden></div>
    </div>
  `;
}

function mockPackages(listPiPackages) {
  const control = {
    listPiPackages: vi.fn().mockResolvedValue(listPiPackages),
    installPiPackage: vi.fn().mockResolvedValue(undefined),
    removePiPackage: vi.fn().mockResolvedValue(undefined),
    updatePiPackage: vi.fn().mockResolvedValue(undefined),
    setPiPackageDisabled: vi.fn().mockResolvedValue(true),
    restartRuntime: vi.fn().mockResolvedValue("instance-new"),
  };
  return control;
}

function sidebarRows() {
  return [...document.querySelectorAll(".pkg-manager-sidebar-row")];
}

function detail() {
  return document.getElementById("pkg-manager-detail");
}

describe("normalizeSource", () => {
  it("passes through a bare source", () => {
    expect(normalizeSource("npm:foo")).toBe("npm:foo");
  });

  it("strips a leading `pi install` command", () => {
    expect(normalizeSource("pi install npm:foo")).toBe("npm:foo");
    expect(normalizeSource(" npm install @scope/pkg ")).toBe("@scope/pkg");
  });

  it("drops flags from a pasted install command", () => {
    expect(normalizeSource("pi install -l npm:foo")).toBe("npm:foo");
  });

  it("returns an empty string for empty input", () => {
    expect(normalizeSource("   ")).toBe("");
  });
});

describe("setupPackageManager", () => {
  beforeEach(() => {
    renderManagerDom();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders an empty note when no packages are installed", async () => {
    const control = mockPackages([]);
    const manager = setupPackageManager({ control });
    await manager.load();
    expect(document.getElementById("pkg-manager-groups").textContent).toContain(
      t("extensions.noInstalled"),
    );
  });

  it("renders a sidebar row per package, grouped by scope, and selects the first one", async () => {
    const control = mockPackages([
      {
        source: "npm:foo",
        scope: "global",
        installedPath: "/Users/me/.pi/agent/npm/foo",
        packageName: "foo",
        version: "1.2.3",
        description: "Adds foo commands to Pi.",
        disabled: false,
        counts: { extensions: 2, skills: 1, prompts: 0, themes: 0 },
        resources: [],
      },
      {
        source: "npm:bar",
        scope: "project",
        installedPath: null,
        packageName: null,
        version: null,
        disabled: true,
        counts: {},
        resources: [],
      },
    ]);
    const manager = setupPackageManager({ control });
    await manager.load();

    const rendered = sidebarRows();
    expect(rendered).toHaveLength(2);
    expect(rendered[0].textContent).toContain("foo");
    expect(rendered[1].textContent).toContain("npm:bar");

    const groups = document.getElementById("pkg-manager-groups");
    expect(groups.textContent).toContain("GLOBAL");
    expect(groups.textContent).toContain("PROJECT");

    // First package is selected by default and shown in the detail pane.
    expect(detail().textContent).toContain("npm:foo");
    expect(detail().textContent).toContain("Adds foo commands to Pi.");
  });

  it("switches the detail pane when a different sidebar row is clicked", async () => {
    const control = mockPackages([
      { source: "npm:foo", scope: "global", disabled: false, counts: {}, resources: [] },
      { source: "npm:bar", scope: "project", disabled: false, counts: {}, resources: [] },
    ]);
    const manager = setupPackageManager({ control });
    await manager.load();

    sidebarRows()[1].click();
    expect(detail().textContent).toContain("npm:bar");
  });

  it("disables the selected package and sends the disable request", async () => {
    const control = mockPackages([
      {
        source: "npm:foo",
        scope: "global",
        installedPath: "/Users/me/.pi/agent/npm/foo",
        packageName: "foo",
        version: "1.2.3",
        disabled: false,
        counts: {},
        resources: [],
      },
    ]);
    const manager = setupPackageManager({ control });
    await manager.load();

    const toggle = detail().querySelector(".pkg-manager-toggle");
    toggle.click();

    await vi.waitFor(() => {
      expect(control.setPiPackageDisabled).toHaveBeenCalledWith("npm:foo", "global", true, "");
    });
  });

  it("reveals the community browse section when the add button is clicked", () => {
    const onBrowseRevealed = vi.fn();
    setupPackageManager({ control: mockPackages([]), onBrowseRevealed });
    const managerSection = document.getElementById("pkg-manager-section");
    const browseSection = document.getElementById("pkg-browse-section");
    expect(managerSection.hidden).toBe(false);
    expect(browseSection.hidden).toBe(true);
    document.getElementById("pkg-manager-add-btn").click();
    expect(managerSection.hidden).toBe(true);
    expect(browseSection.hidden).toBe(false);
    expect(onBrowseRevealed).toHaveBeenCalled();
  });

  it("restarts the runtime and calls onRestarted when reload is clicked", async () => {
    const control = mockPackages([
      {
        source: "npm:foo",
        scope: "global",
        installedPath: "/Users/me/.pi/agent/npm/foo",
        packageName: "foo",
        version: "1.2.3",
        disabled: false,
        counts: {},
        resources: [],
      },
    ]);
    const onRestarted = vi.fn();
    const manager = setupPackageManager({
      control,
      getWorkspaceId: () => "ws-1",
      getSessionId: () => "s-1",
      onRestarted,
    });
    await manager.load();

    document.getElementById("pkg-manager-reload-btn").click();

    await vi.waitFor(() => {
      expect(control.restartRuntime).toHaveBeenCalledWith("ws-1", "s-1");
      expect(onRestarted).toHaveBeenCalledTimes(1);
    });
  });
});
