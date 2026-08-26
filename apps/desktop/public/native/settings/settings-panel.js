import { t } from "../../i18n.js";
import { applyTheme, getCurrentTheme, themes } from "../../themes.js";
import { applyLoadingPlaceholder, clearLoadingPlaceholder } from "../../ui/loading-placeholder.js";
import { loadCostDashboard } from "./cost-dashboard.js";
import { setupLanguageSelector } from "./language-selector.js";
import { setupPackageBrowse } from "./package-browse.js";
import { setupPackageManager } from "./package-manager.js";
import { setupSettingsConfig } from "./settings-config.js";
import { setupSettingsToggles } from "./settings-toggles.js";
import { setupSkillsCatalogPanel } from "./skills-catalog-panel.js";
import { setupSkillsCollectionsPanel } from "./skills-collections-panel.js";
import { setupSkillsInstallTab } from "./skills-install-tab.js";
import { renderSkillPanelMessage } from "./skills-management-ui.js";
import { createSkillsRuntimeClient } from "./skills-runtime-client.js";
import { setupSessionSkillsPanel } from "./skills-session-panel.js";
import { setupSkillsTabShell } from "./skills-tab-shell.js";
import { setupThinkingEffortControl } from "./thinking-effort-control.js";

// Wires the settings overlay panel for the native runtime: open/close, tab
// switching, theme grid, the bundled OMP version readout, the Usage tab (cost
// dashboard), the Extensions tab (community package browse), and the
// Configuration tab (API keys / model catalog + agent-config / models.json
// editors). When `data` + `getWorkspaceId` are supplied the Usage tab loads
// aggregated cost data from the native host on first open. `control` is a
// HostControlGateway (or null) used by the Extensions tab to list/install/remove
// packages via the bundled OMP CLI. `configGateway` (or null) drives the
// Configuration tab via the picot-bridge extension. Both tabs are populated
// lazily whenever they are shown.
export function setupSettingsPanel({
  data,
  getWorkspaceId,
  control,
  configGateway,
  onModelConfigurationChanged,
  runtime,
  getTarget,
  globalSkillsClient,
  onError,
  notify,
  onRestarted,
  onThinkingLevelChanged,
} = {}) {
  const panel = document.getElementById("settings-panel");
  const openBtn = document.getElementById("settings-btn");
  const closeBtn = document.getElementById("settings-close");
  const overlay = document.getElementById("settings-overlay");
  const extensionsBtn = document.getElementById("sidebar-extensions-btn");
  const skillsBtn = document.getElementById("sidebar-skills-btn");
  if (!panel || !openBtn) return;

  const resourceDialogHeader = document.createElement("header");
  resourceDialogHeader.className = "resource-dialog-header";
  const resourceDialogTitle = document.createElement("strong");
  const resourceDialogClose = document.createElement("button");
  resourceDialogClose.type = "button";
  resourceDialogClose.className = "ui-icon-button ui-icon-button--sm ui-icon-button--ghost";
  resourceDialogClose.setAttribute("aria-label", "Close");
  resourceDialogClose.textContent = "×";
  resourceDialogHeader.append(resourceDialogTitle, resourceDialogClose);
  panel.prepend(resourceDialogHeader);

  const navItems = Array.from(document.querySelectorAll(".settings-nav-item"));
  const tabs = Array.from(document.querySelectorAll(".settings-tab"));
  const validTabKeys = new Set(navItems.map((item) => item.dataset.settingsTab));
  const themeGrid = document.getElementById("theme-grid");
  const piVersionValue = document.getElementById("setting-pi-version-value");
  const appVersionValue = document.getElementById("setting-app-version-value");
  const costDashboard = document.getElementById("settings-cost-dashboard");
  const packageBrowse = setupPackageBrowse(control, { notify });
  const packageManager = setupPackageManager({
    control,
    data,
    notify,
    getWorkspaceId,
    getSessionId: () => getTarget?.()?.sessionId,
    onRestarted,
    onBrowseRevealed: () => void packageBrowse.load(),
  });
  const config = configGateway
    ? setupSettingsConfig({ configGateway, onModelConfigurationChanged })
    : null;
  const thinkingControl = setupThinkingEffortControl({
    runtime,
    getTarget,
    configGateway,
    onError,
    onRuntimeLevelChanged: onThinkingLevelChanged,
  });
  const sessionSkillsClient =
    runtime && getTarget ? createSkillsRuntimeClient({ runtime, getTarget }) : null;
  const skillsClient = sessionSkillsClient ?? globalSkillsClient;
  const showSkillsSuccess = notify
    ? (message) => notify({ type: "success", title: t("status.saved"), message })
    : undefined;
  const showSkillsError = notify
    ? (error) =>
        notify({
          type: "error",
          title: t("settings.skills.saveFailed"),
          message: error instanceof Error ? error.message : String(error),
        })
    : (error) => onError?.(error);

  const catalogTab = skillsClient
    ? setupSkillsCatalogPanel({
        container: document.getElementById("settings-skills"),
        client: skillsClient,
        showError: showSkillsError,
      })
    : null;
  const collectionsTab = skillsClient
    ? setupSkillsCollectionsPanel({
        container: document.getElementById("settings-skill-collections"),
        client: skillsClient,
        showSuccess: showSkillsSuccess,
        showError: showSkillsError,
      })
    : null;
  const sessionSkillsTab = setupSessionSkillsPanel({
    container: document.getElementById("settings-session-skills"),
    client: sessionSkillsClient,
    showSuccess: showSkillsSuccess,
    showError: showSkillsError,
  });
  const installTab =
    control && getWorkspaceId
      ? setupSkillsInstallTab({
          container: document.getElementById("settings-install-skills"),
          transport: control,
          getWorkspaceId,
          isProjectTrusted: () => true,
          onInstalled: skillsClient
            ? async () => {
                await skillsClient.catalogRescan();
                await Promise.all([
                  catalogTab?.reload?.(),
                  collectionsTab?.reload?.(),
                  sessionSkillsTab?.reload?.(),
                ]);
              }
            : undefined,
          showSuccess: showSkillsSuccess,
          showError: showSkillsError,
        })
      : {
          activate: () =>
            renderSkillPanelMessage(
              document.getElementById("settings-install-skills"),
              t("settings.skills.sessionUnavailable"),
            ),
        };
  const skillsTabs = Array.from(document.querySelectorAll("[data-skills-page-tab]"));
  const skillsPanels = {
    catalog: document.getElementById("settings-skills"),
    collections: document.getElementById("settings-skill-collections"),
    session: document.getElementById("settings-session-skills"),
    install: document.getElementById("settings-install-skills"),
  };
  const skillsShell = setupSkillsTabShell({
    tabs: skillsTabs,
    panels: skillsPanels,
    activate: (name) => {
      if (name === "catalog") catalogTab?.activate?.();
      else if (name === "collections") collectionsTab?.activate?.();
      else if (name === "session") sessionSkillsTab?.activate?.();
      else if (name === "install") installTab?.activate?.();
    },
  });

  function skillsVisible() {
    return (
      !panel.classList.contains("hidden") &&
      document.querySelector('[data-settings-panel="skills"]')?.classList.contains("active")
    );
  }

  function currentSkillsTab() {
    return skillsTabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.dataset
      .skillsPageTab;
  }

  function sameTarget(frameTarget) {
    const activeTarget = getTarget?.();
    return Boolean(
      activeTarget &&
        frameTarget?.workspaceId === activeTarget.workspaceId &&
        frameTarget?.sessionId === activeTarget.sessionId &&
        frameTarget?.instanceId === activeTarget.instanceId,
    );
  }

  runtime?.subscribe?.((frame) => {
    const updateType = frame?.type === "runtime_event" ? frame.event?.type : null;
    if (
      !skillsVisible() ||
      !sameTarget(frame?.target) ||
      !["skills_catalog_update", "skills_collections_update", "session_skills_update"].includes(
        updateType,
      )
    )
      return;

    const tab = currentSkillsTab();
    if (tab === "catalog" && updateType === "skills_catalog_update") void catalogTab?.reload?.();
    else if (
      tab === "collections" &&
      ["skills_catalog_update", "skills_collections_update"].includes(updateType)
    )
      void collectionsTab?.reload?.();
    else if (tab === "session") void sessionSkillsTab?.reload?.();
  });

  const skillsPage = {
    activate: () => skillsShell.refresh(),
  };
  setupLanguageSelector();
  setupSettingsToggles({ configGateway, onError });
  let usageLoaded = false;

  function loadUsage() {
    if (usageLoaded || !costDashboard || !data || !getWorkspaceId) return;
    usageLoaded = true;
    void loadCostDashboard(costDashboard, { data, getWorkspaceId });
  }

  function loadConfiguration() {
    if (!config) return;
    void config.loadApiKeysPanel();
    void config.loadInlineConfigEditor();
    void config.loadInlineModelsEditor();
  }

  function setExtensionsView(mode) {
    const managerSection = document.getElementById("pkg-manager-section");
    const browseSection = document.getElementById("pkg-browse-section");
    const browseCloseBtn = document.getElementById("pkg-browse-close-btn");
    const marketplaceMode = mode === "marketplace";

    if (managerSection) managerSection.hidden = marketplaceMode;
    if (browseSection) browseSection.hidden = !marketplaceMode;
    if (browseCloseBtn) browseCloseBtn.hidden = marketplaceMode;

    if (marketplaceMode) {
      void packageBrowse.load();
    } else {
      void packageManager.load();
    }
  }

  function selectTab(tabKey = "general") {
    const target = tabKey === "auth" ? "configuration" : tabKey;
    for (const item of navItems) {
      item.classList.toggle("active", item.dataset.settingsTab === target);
    }
    for (const tab of tabs) {
      tab.classList.toggle("active", tab.dataset.settingsPanel === target);
    }

    if (target === "usage") loadUsage();
    if (target === "extensions") {
      setExtensionsView(panel.classList.contains("resource-dialog") ? "installed" : "marketplace");
    }
    if (target === "skills") void skillsPage.activate();
    if (target === "configuration") loadConfiguration();
  }

  function buildThemeGrid() {
    if (!themeGrid) return;
    themeGrid.replaceChildren();
    const current = getCurrentTheme();
    for (const [id, theme] of Object.entries(themes)) {
      const btn = document.createElement("button");
      btn.className = `theme-swatch${current === id ? " active" : ""}`;
      const colors = document.createElement("span");
      colors.className = "swatch-colors";
      for (const color of theme.colors || []) {
        const dot = document.createElement("span");
        dot.className = "swatch-dot";
        dot.style.background = color;
        colors.append(dot);
      }
      btn.append(colors);
      btn.addEventListener("click", () => {
        applyTheme(id);
        for (const swatch of themeGrid.querySelectorAll(".theme-swatch")) {
          swatch.classList.remove("active");
        }
        btn.classList.add("active");
      });
      themeGrid.append(btn);
    }
  }

  async function loadPiVersion() {
    if (!piVersionValue) return;
    applyLoadingPlaceholder(piVersionValue, {
      label: t("migrated.native.settings.settingsConfig.textcontent.loading"),
    });
    try {
      const response = await fetch("/health");
      const health = await response.json();
      clearLoadingPlaceholder(piVersionValue);
      piVersionValue.textContent = health?.ompVersion || "Unavailable";
    } catch {
      clearLoadingPlaceholder(piVersionValue);
      piVersionValue.textContent = t("sidebar.unavailable");
    }
  }

  async function loadAppVersion() {
    if (!appVersionValue) return;
    try {
      const version = await globalThis.__TAURI__?.app?.getVersion?.();
      clearLoadingPlaceholder(appVersionValue);
      appVersionValue.textContent = version ? `v${version}` : "Unavailable";
    } catch {
      clearLoadingPlaceholder(appVersionValue);
      appVersionValue.textContent = t("sidebar.unavailable");
    }
  }

  // Persist "settings is open, on tab X" to the URL hash (independent of the
  // path-based session route) so a page refresh — or opening a link that
  // still has the hash from before a reload — reopens the same settings tab
  // instead of silently dropping back to the chat view.
  function normalizeSettingsTabKey(tabKey) {
    const rawTabKey = typeof tabKey === "string" ? tabKey : "general";
    const decodedTabKey = decodeURIComponent(rawTabKey || "general");
    const normalizedTabKey = decodedTabKey === "auth" ? "configuration" : decodedTabKey;
    return validTabKeys.has(normalizedTabKey) ? normalizedTabKey : "general";
  }

  function settingsHashForTab(tabKey) {
    return `#/settings/${encodeURIComponent(normalizeSettingsTabKey(tabKey))}`;
  }

  function updateSettingsHash(tabKey) {
    const nextHash = settingsHashForTab(tabKey);
    if (window.location.hash === nextHash) return;
    history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${nextHash}`,
    );
  }

  function clearSettingsHash() {
    if (!window.location.hash.startsWith("#/settings")) return;
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }

  function setResourceDialogMode(enabled) {
    panel.classList.toggle("resource-dialog", enabled);
    overlay?.classList.toggle("resource-dialog-overlay", enabled);
  }

  function openSettings(tabKey = "general", { updateHash = true } = {}) {
    const normalizedTabKey = normalizeSettingsTabKey(tabKey);
    setResourceDialogMode(false);
    if (updateHash) updateSettingsHash(normalizedTabKey);
    panel.classList.remove("hidden");
    selectTab(normalizedTabKey);
    buildThemeGrid();
    void loadPiVersion();
    void loadAppVersion();
  }

  function openResourceDialog(tabKey) {
    clearSettingsHash();
    setResourceDialogMode(true);
    resourceDialogTitle.textContent =
      tabKey === "skills" ? t("migrated.index.text.skills") : t("migrated.index.text.extensions");
    panel.classList.remove("hidden");
    selectTab(tabKey);
  }

  function closeSettings({ clearHash = true } = {}) {
    if (clearHash) clearSettingsHash();
    panel.classList.add("hidden");
    setResourceDialogMode(false);
  }

  function restoreFromHash() {
    const route = window.location.hash.slice(1);
    if (route === "/settings" || route.startsWith("/settings/")) {
      const tabKey = route.split("/")[2] || "general";
      openSettings(tabKey, { updateHash: false });
      return;
    }
    if (!panel.classList.contains("hidden")) closeSettings({ clearHash: false });
  }

  function targetChanged() {
    if (skillsVisible()) skillsShell.refresh();
  }

  openBtn.addEventListener("click", () => openSettings());
  extensionsBtn?.addEventListener("click", () => openResourceDialog("extensions"));
  skillsBtn?.addEventListener("click", () => openResourceDialog("skills"));
  resourceDialogClose.addEventListener("click", () => closeSettings());
  closeBtn?.addEventListener("click", () => closeSettings());
  overlay?.addEventListener("click", () => closeSettings());
  for (const item of navItems) {
    item.addEventListener("click", () => {
      selectTab(item.dataset.settingsTab);
      updateSettingsHash(item.dataset.settingsTab);
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.classList.contains("hidden")) closeSettings();
  });
  window.addEventListener("hashchange", restoreFromHash);
  restoreFromHash();

  return { openSettings, closeSettings, targetChanged, thinkingControl };
}
