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

function mockPlugins(listOmpPlugins) {
  const control = {
    listOmpPlugins: vi.fn().mockResolvedValue(listOmpPlugins),
    installOmpPlugin: vi.fn().mockResolvedValue(undefined),
    uninstallOmpPlugin: vi.fn().mockResolvedValue(undefined),
    updateOmpPlugin: vi.fn().mockResolvedValue(undefined),
    setOmpPluginEnabled: vi.fn().mockResolvedValue(undefined),
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

  it("strips a leading `omp plugin install` command", () => {
    expect(normalizeSource("omp plugin install npm:foo")).toBe("npm:foo");
    expect(normalizeSource(" npm install @scope/pkg ")).toBe("@scope/pkg");
  });

  it("drops flags from a pasted install command", () => {
    expect(normalizeSource("omp plugin install --force npm:foo")).toBe("npm:foo");
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
    const control = mockPlugins({ npm: [], marketplace: [] });
    const manager = setupPackageManager({ control });
    await manager.load();
    expect(document.getElementById("pkg-manager-groups").textContent).toContain(
      t("extensions.noInstalled"),
    );
  });

  it("renders a sidebar row per package, grouped by scope, and selects the first one", async () => {
    const control = mockPlugins({
      npm: [
        {
          name: "foo",
          path: "/Users/me/.omp/agent/plugins/node_modules/foo",
          version: "1.2.3",
          enabled: true,
          manifest: { description: "Adds foo commands to OMP.", extensions: ["foo.ts"] },
        },
      ],
      marketplace: [
        {
          id: "bar@official",
          scope: "project",
          entries: [{ installPath: "/tmp/bar", version: "2.0.0", enabled: false }],
        },
      ],
    });
    const manager = setupPackageManager({ control });
    await manager.load();

    const rendered = sidebarRows();
    expect(rendered).toHaveLength(2);
    expect(rendered[0].textContent).toContain("foo");
    expect(rendered[1].textContent).toContain("bar@official");

    const groups = document.getElementById("pkg-manager-groups");
    expect(groups.textContent).toContain("GLOBAL");
    expect(groups.textContent).toContain("PROJECT");

    // First package is selected by default and shown in the detail pane.
    expect(detail().textContent).toContain("foo");
    expect(detail().textContent).toContain("Adds foo commands to OMP.");
  });

  it("switches the detail pane when a different sidebar row is clicked", async () => {
    const control = mockPlugins({
      npm: [{ name: "foo", enabled: true, manifest: {} }],
      marketplace: [{ id: "bar@official", scope: "project", entries: [{ enabled: true }] }],
    });
    const manager = setupPackageManager({ control });
    await manager.load();

    sidebarRows()[1].click();
    expect(detail().textContent).toContain("bar@official");
  });

  it("disables the selected package and sends the disable request", async () => {
    const control = mockPlugins({
      npm: [
        {
          name: "foo",
          path: "/Users/me/.omp/agent/plugins/node_modules/foo",
          version: "1.2.3",
          enabled: true,
          manifest: {},
        },
      ],
      marketplace: [],
    });
    const manager = setupPackageManager({ control });
    await manager.load();

    const toggle = detail().querySelector(".pkg-manager-toggle");
    toggle.click();

    await vi.waitFor(() => {
      expect(control.setOmpPluginEnabled).toHaveBeenCalledWith("foo", false, {
        kind: "npm",
        scope: "user",
        cwd: "",
      });
    });
  });

  it("reveals the community browse section when the add button is clicked", () => {
    const onBrowseRevealed = vi.fn();
    setupPackageManager({
      control: mockPlugins({ npm: [], marketplace: [] }),
      onBrowseRevealed,
    });
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
    const control = mockPlugins({
      npm: [{ name: "foo", version: "1.2.3", enabled: true, manifest: {} }],
      marketplace: [],
    });
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
