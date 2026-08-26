import { initI18n, t } from "../i18n.js";
import { applyTheme, getCurrentTheme } from "../themes.js";
import { setupAppUpdater } from "./features/app-updater.js";
import { resolveRemoteAuth } from "./features/remote-auth.js";
import { SessionSidebar } from "./session/session-sidebar.js";
import { setupSettingsPanel } from "./settings/settings-panel.js";
import { createSkillsGlobalClient } from "./settings/skills-runtime-client.js";
import { signalConfigGatewayReady } from "./transport/config-gateway-readiness.js";
import { HostControlGateway } from "./transport/control-gateway.js";
import { HostDataGateway } from "./transport/data-gateway.js";
import { HostConfigGateway } from "./transport/host-config-gateway.js";
import { HostRuntimeAdapter, resolveHostWebSocketUrl } from "./transport/runtime-adapter.js";
import { randomId } from "./utils/random-id.js";
import { appRoutePath } from "./utils/router.js";
import { resolveWorkspaceViaHost, setupOpenFolderButton } from "./workspace/workspace-actions.js";

function showHomeShell() {
  document.body.dataset.route = "home";
  document.querySelector(".session-header")?.classList.add("hidden");
  document.querySelector(".input-area")?.classList.add("hidden");
  document.querySelector(".welcome .hint")?.classList.add("hidden");
  document.querySelector(".shortcuts-hint")?.classList.add("hidden");
  document.getElementById("new-session-btn")?.classList.add("hidden");

  const settingsBack = document.querySelector("#settings-close span");
  if (settingsBack) {
    settingsBack.dataset.i18n = "workspace.back";
    settingsBack.textContent = t("workspace.back");
  }
}

function setupHomeSessionSearch(sidebar) {
  const input = document.getElementById("session-search-input");
  const clear = document.getElementById("session-search-clear");
  if (!input) return;

  input.addEventListener("input", () => {
    sidebar.setSearchQuery(input.value);
    clear?.classList.toggle("hidden", input.value.length === 0);
  });
  clear?.addEventListener("click", () => {
    input.value = "";
    clear.classList.add("hidden");
    sidebar.setSearchQuery("");
    input.focus();
  });
}

function homeClientId(clientType) {
  const key = "picot:host-client-id";
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const created = `${clientType}-${randomId()}`;
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    return `${clientType}-${randomId()}`;
  }
}

function createLazyHomeControl({ fetchImpl, location }) {
  let controlPromise;
  const getControl = async () => {
    if (!controlPromise) {
      controlPromise = (async () => {
        const authLocation = location?.href ? location : window.location;
        const auth = await resolveRemoteAuth({ location: authLocation, fetchImpl });
        const adapter = new HostRuntimeAdapter({
          url: resolveHostWebSocketUrl({ location: authLocation }),
          clientId: homeClientId(auth.clientType),
          clientType: auth.clientType,
          deviceToken: auth.deviceToken,
        });
        adapter.connect();
        await adapter.ready();
        return new HostControlGateway(adapter);
      })();
    }
    return controlPromise;
  };

  const callControl = (method, ...args) => getControl().then((control) => control[method](...args));

  return {
    listOmpPlugins: (...args) => callControl("listOmpPlugins", ...args),
    installOmpPlugin: (...args) => callControl("installOmpPlugin", ...args),
    uninstallOmpPlugin: (...args) => callControl("uninstallOmpPlugin", ...args),
    updateOmpPlugin: (...args) => callControl("updateOmpPlugin", ...args),
    setOmpPluginEnabled: (...args) => callControl("setOmpPluginEnabled", ...args),
    skillManagementRequest: (...args) => callControl("skillManagementRequest", ...args),
    configManagementRequest: (...args) => callControl("configManagementRequest", ...args),
    restartRuntime: (...args) => callControl("restartRuntime", ...args),
    listInstalledApps: (...args) => callControl("listInstalledApps", ...args),
    openInApp: (...args) => callControl("openInApp", ...args),
    openExternal: (...args) => callControl("openExternal", ...args),
    deleteSessions: (...args) => callControl("deleteSessions", ...args),
    pickSkillSource: (...args) => callControl("pickSkillSource", ...args),
    scanSkillInstallSource: (...args) => callControl("scanSkillInstallSource", ...args),
    installSkillLinks: (...args) => callControl("installSkillLinks", ...args),
  };
}

export async function openHomeSession(
  session,
  {
    resolveWorkspace = resolveWorkspaceViaHost,
    navigate = (path) => window.location.assign(path),
    invoke = globalThis.__TAURI__?.core?.invoke,
  } = {},
) {
  if (!session?.id || !session?.projectPath) throw new Error("Session route is incomplete");
  if (invoke) {
    await invoke("open_session_in_project", {
      projectPath: session.projectPath,
      sessionId: session.id,
    });
    return;
  }
  const workspaceId = session.workspaceId || (await resolveWorkspace(session.projectPath));
  navigate(appRoutePath({ name: "session", workspaceId, sessionId: session.id }));
}

export async function startHomeApp({
  fetchImpl = window.fetch.bind(window),
  location = window.location,
  resolveWorkspace = resolveWorkspaceViaHost,
  navigate,
  invoke = globalThis.__TAURI__?.core?.invoke,
  configGateway,
} = {}) {
  applyTheme(getCurrentTheme());
  await initI18n();
  showHomeShell();

  const data = new HostDataGateway(null, { fetchImpl, location });
  const control = createLazyHomeControl({ fetchImpl, location });
  const globalSkillsClient = createSkillsGlobalClient({ control, getCwd: () => "" });
  const globalConfigGateway = configGateway ?? new HostConfigGateway(control);
  const container = document.getElementById("session-list");
  const sidebar = container
    ? new SessionSidebar(container, {
        data,
        getTarget: () => null,
        workspaceNeutral: true,
        onSelect: (session) => {
          void openHomeSession(session, { resolveWorkspace, navigate, invoke }).catch((error) => {
            console.error("[Home] Failed to open session:", error);
          });
        },
      })
    : null;

  const settingsPanel = setupSettingsPanel({
    control,
    globalSkillsClient,
    configGateway: globalConfigGateway,
  });
  window.__picotConfigCall = (operation, params, options) =>
    globalConfigGateway.call(operation, params, options);
  signalConfigGatewayReady();
  setupAppUpdater({ settingsPanel });
  setupOpenFolderButton({
    onError: (error) => console.error("[Home] Failed to open workspace:", error),
  });
  if (sidebar) {
    setupHomeSessionSearch(sidebar);
    document.getElementById("refresh-sessions-btn")?.addEventListener("click", () => {
      void sidebar.load({ acceptEmpty: true });
    });
    await sidebar.load({ acceptEmpty: true });
  }

  return { sidebar, redirected: false };
}
