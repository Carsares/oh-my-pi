import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupSettingsPanel } from "./settings-panel.js";

function renderSettingsDom() {
  document.body.innerHTML = `
    <button id="settings-btn"></button>
    <button id="sidebar-extensions-btn"></button>
    <button id="sidebar-skills-btn"></button>
    <div class="settings-overlay hidden" id="settings-overlay"></div>
    <div class="settings-panel hidden" id="settings-panel">
      <aside class="settings-nav">
        <button class="settings-nav-item active" data-settings-tab="general">General</button>
        <button class="settings-nav-item" data-settings-tab="extensions">Extensions</button>
        <button class="settings-nav-item" data-settings-tab="skills">Skills</button>
        <button class="settings-nav-item" data-settings-tab="usage">Usage</button>
        <button class="settings-nav-item" data-settings-tab="configuration">Configuration</button>
        <button class="settings-nav-back" id="settings-close">Back</button>
      </aside>
      <section class="settings-content">
        <div class="settings-tab active" data-settings-panel="general"></div>
        <div class="settings-tab" data-settings-panel="extensions">
          <div class="settings-section" id="pkg-manager-section"></div>
          <div class="settings-section" id="pkg-browse-section" hidden></div>
        </div>
        <div class="settings-tab" data-settings-panel="skills">
          <button class="skills-page-tab active" data-skills-page-tab="catalog"></button>
          <button class="skills-page-tab" data-skills-page-tab="collections"></button>
          <button class="skills-page-tab" data-skills-page-tab="session"></button>
          <button class="skills-page-tab" data-skills-page-tab="install"></button>
          <div id="settings-skills"></div>
          <div id="settings-skill-collections"></div>
          <div id="settings-session-skills"></div>
          <div id="settings-install-skills"></div>
        </div>
        <div class="settings-tab" data-settings-panel="usage">
          <cost-dashboard id="settings-cost-dashboard"></cost-dashboard>
        </div>
        <div class="settings-tab" data-settings-panel="configuration"></div>
      </section>
    </div>
  `;
}

describe("settings panel hash routing", () => {
  beforeEach(() => {
    renderSettingsDom();
    history.replaceState(null, "", "/app/workspaces/workspace-a/sessions/session-a");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    history.replaceState(null, "", "/app/workspaces/workspace-a/sessions/session-a");
  });

  it("writes #/settings/<tab> to the URL hash when a tab is opened", () => {
    const panel = setupSettingsPanel();
    panel.openSettings("usage");

    expect(window.location.hash).toBe("#/settings/usage");
    expect(document.getElementById("settings-panel").classList.contains("hidden")).toBe(false);
  });

  it("shows a no-workspace state without requesting Usage data on the root page", () => {
    const data = { costDashboard: vi.fn() };
    const panel = setupSettingsPanel({ data });

    panel.openSettings("usage");

    const dashboard = document.getElementById("settings-cost-dashboard");
    expect(dashboard.querySelector(".cost-dash-empty-state").textContent).toBe(
      "cost.workspaceRequired",
    );
    expect(data.costDashboard).not.toHaveBeenCalled();
  });

  it("keeps loading Usage through the active workspace data gateway", async () => {
    const data = { costDashboard: vi.fn(async () => ({ dashboard: {} })) };
    const getWorkspaceId = vi.fn(() => "workspace-a");
    const panel = setupSettingsPanel({ data, getWorkspaceId });

    panel.openSettings("usage");

    await vi.waitFor(() => expect(data.costDashboard).toHaveBeenCalledWith("workspace-a"));
  });

  it("clears the hash when settings is closed", () => {
    const panel = setupSettingsPanel();
    panel.openSettings("general");
    panel.closeSettings();

    expect(window.location.hash).toBe("");
    expect(document.getElementById("settings-panel").classList.contains("hidden")).toBe(true);
  });

  it("reopens the settings panel on the saved tab when the hash is already present at load", () => {
    // Simulates a page refresh: the hash survives reload, so setup must
    // restore settings-open state instead of leaving the user on chat.
    window.location.hash = "#/settings/configuration";

    setupSettingsPanel();

    const panel = document.getElementById("settings-panel");
    expect(panel.classList.contains("hidden")).toBe(false);
    const configTab = document.querySelector('[data-settings-panel="configuration"]');
    expect(configTab.classList.contains("active")).toBe(true);
  });

  it("falls back to the general tab for an unknown hash tab key", () => {
    window.location.hash = "#/settings/does-not-exist";

    setupSettingsPanel();

    const generalTab = document.querySelector('[data-settings-panel="general"]');
    expect(generalTab.classList.contains("active")).toBe(true);
  });

  it("responds to hashchange events fired after setup (e.g. back/forward navigation)", () => {
    setupSettingsPanel();
    expect(document.getElementById("settings-panel").classList.contains("hidden")).toBe(true);

    window.location.hash = "#/settings/extensions";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(document.getElementById("settings-panel").classList.contains("hidden")).toBe(false);
    const extensionsTab = document.querySelector('[data-settings-panel="extensions"]');
    expect(extensionsTab.classList.contains("active")).toBe(true);
  });

  it("opens sidebar Extensions as the installed-package dialog without changing the route", () => {
    setupSettingsPanel();

    document.getElementById("sidebar-extensions-btn").click();

    const panel = document.getElementById("settings-panel");
    expect(panel.classList.contains("resource-dialog")).toBe(true);
    expect(
      document.querySelector('[data-settings-panel="extensions"]').classList.contains("active"),
    ).toBe(true);
    expect(document.getElementById("pkg-manager-section").hidden).toBe(false);
    expect(document.getElementById("pkg-browse-section").hidden).toBe(true);
    expect(window.location.hash).toBe("");

    document.querySelector(".resource-dialog-header button").click();
    expect(panel.classList.contains("hidden")).toBe(true);
  });

  it("opens Settings → Extensions as the package marketplace", () => {
    const panelApi = setupSettingsPanel();

    panelApi.openSettings("extensions");

    const panel = document.getElementById("settings-panel");
    expect(panel.classList.contains("resource-dialog")).toBe(false);
    expect(document.getElementById("pkg-manager-section").hidden).toBe(true);
    expect(document.getElementById("pkg-browse-section").hidden).toBe(false);
  });

  it("loads Skills lazily and refreshes matching runtime updates for the active target", async () => {
    const configGateway = { call: vi.fn(async () => ({ ok: true, data: {} })) };
    let runtimeListener;
    const runtime = {
      request: vi.fn(async () => ({
        response: { success: true, data: { revision: 1, entries: [] } },
      })),
      subscribe: vi.fn((listener) => {
        runtimeListener = listener;
        return () => {};
      }),
    };
    let target = { workspaceId: "workspace-a", sessionId: "session-a", instanceId: 1 };
    const getTarget = () => target;

    const panel = setupSettingsPanel({ configGateway, runtime, getTarget });
    expect(runtime.request).not.toHaveBeenCalled();
    panel.openSettings("skills");

    expect(window.location.hash).toBe("#/settings/skills");
    expect(
      document.querySelector('[data-settings-panel="skills"]').classList.contains("active"),
    ).toBe(true);
    expect(runtime.request).toHaveBeenCalledWith(
      { type: "skills_catalog_list" },
      getTarget(),
      undefined,
    );
    expect(configGateway.call).not.toHaveBeenCalledWith("list_skill_inventory", expect.anything());
    await vi.waitFor(() => {
      expect(document.getElementById("settings-skills").textContent).toContain(
        "settings.skills.empty",
      );
    });

    runtime.request.mockClear();
    runtimeListener({
      type: "runtime_event",
      target,
      event: { type: "skills_catalog_update" },
    });
    expect(runtime.request).toHaveBeenCalledWith(
      { type: "skills_catalog_list" },
      target,
      undefined,
    );

    runtime.request.mockClear();
    runtimeListener({
      type: "runtime_event",
      target: { ...target, sessionId: "background-session" },
      event: { type: "skills_catalog_update" },
    });
    expect(runtime.request).not.toHaveBeenCalled();

    document.querySelector('[data-skills-page-tab="collections"]').click();
    await vi.waitFor(() =>
      expect(runtime.request).toHaveBeenCalledWith(
        { type: "skills_collection_list" },
        target,
        undefined,
      ),
    );
    runtime.request.mockClear();
    runtimeListener({
      type: "runtime_event",
      target,
      event: { type: "skills_collections_update" },
    });
    expect(runtime.request).toHaveBeenCalledWith(
      { type: "skills_collection_list" },
      target,
      undefined,
    );

    document.querySelector('[data-skills-page-tab="session"]').click();
    await vi.waitFor(() =>
      expect(runtime.request).toHaveBeenCalledWith(
        { type: "session_skills_get" },
        target,
        undefined,
      ),
    );
    runtime.request.mockClear();
    runtimeListener({
      type: "runtime_event",
      target,
      event: { type: "session_skills_update" },
    });
    expect(runtime.request).toHaveBeenCalledWith({ type: "session_skills_get" }, target, undefined);

    target = { workspaceId: "workspace-a", sessionId: "session-b", instanceId: 2 };
    panel.targetChanged();
    expect(runtime.request).toHaveBeenCalledWith({ type: "session_skills_get" }, target, undefined);
  });

  it("uses the global Skills client without an active session", async () => {
    const globalSkillsClient = {
      catalogList: vi.fn(async () => ({ revision: 1, entries: [] })),
      collectionsList: vi.fn(async () => ({
        state: { revision: 1, defaultCollectionId: "local-all", collections: [] },
        collections: [{ collectionId: "local-all", name: "All", skillIds: [], virtual: true }],
      })),
      collectionGet: vi.fn(async () => ({
        state: { revision: 1, defaultCollectionId: "local-all", collections: [] },
        collection: { collectionId: "local-all", name: "All", skillIds: [], virtual: true },
      })),
    };

    const panel = setupSettingsPanel({ globalSkillsClient });
    panel.openSettings("skills");

    await vi.waitFor(() => expect(globalSkillsClient.catalogList).toHaveBeenCalledTimes(1));
    document.querySelector('[data-skills-page-tab="session"]').click();
    expect(document.getElementById("settings-session-skills").textContent).toContain(
      "settings.skills.sessionUnavailable",
    );

    document.querySelector('[data-skills-page-tab="collections"]').click();
    await vi.waitFor(() => expect(globalSkillsClient.collectionsList).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(globalSkillsClient.collectionGet).toHaveBeenCalledWith("local-all"),
    );
  });
});
