import { initI18n, t } from "../i18n.js";
import { applyTheme, getCurrentTheme } from "../themes.js";
import { SessionSidebar } from "./session/session-sidebar.js";
import { setupSettingsPanel } from "./settings/settings-panel.js";
import { getActiveRuntime } from "./transport/active-runtime.js";
import { HostDataGateway } from "./transport/data-gateway.js";
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

export async function openHomeSession(
  session,
  {
    resolveWorkspace = resolveWorkspaceViaHost,
    navigate = (path) => window.location.assign(path),
  } = {},
) {
  if (!session?.id || !session?.projectPath) throw new Error("Session route is incomplete");
  const workspaceId = session.workspaceId || (await resolveWorkspace(session.projectPath));
  navigate(appRoutePath({ name: "session", workspaceId, sessionId: session.id }));
}

export async function startHomeApp({
  fetchImpl = window.fetch.bind(window),
  location = window.location,
  resolveWorkspace = resolveWorkspaceViaHost,
  navigate,
} = {}) {
  const activeTarget = await getActiveRuntime({ fetchImpl, location });
  if (activeTarget) {
    const path = appRoutePath({
      name: "session",
      workspaceId: activeTarget.workspaceId,
      sessionId: activeTarget.sessionId,
    });
    (navigate ?? ((targetPath) => window.location.assign(targetPath)))(path);
    return { sidebar: null, redirected: true };
  }

  applyTheme(getCurrentTheme());
  await initI18n();
  showHomeShell();

  const data = new HostDataGateway(null, { fetchImpl, location });
  const container = document.getElementById("session-list");
  const sidebar = container
    ? new SessionSidebar(container, {
        data,
        getTarget: () => null,
        workspaceNeutral: true,
        onSelect: (session) => {
          void openHomeSession(session, { resolveWorkspace, navigate }).catch((error) => {
            console.error("[Home] Failed to open session:", error);
          });
        },
      })
    : null;

  setupSettingsPanel();
  setupOpenFolderButton({
    onError: (error) => console.error("[Home] Failed to open workspace:", error),
  });
  if (sidebar) {
    setupHomeSessionSearch(sidebar);
    document.getElementById("refresh-sessions-btn")?.addEventListener("click", () => {
      void sidebar.load();
    });
    await sidebar.load();
  }

  return { sidebar, redirected: false };
}
