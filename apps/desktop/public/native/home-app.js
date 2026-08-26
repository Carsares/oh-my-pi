import { initI18n, t } from "../i18n.js";
import { applyTheme, getCurrentTheme } from "../themes.js";
import { resolveRemoteAuth } from "./features/remote-auth.js";
import { SessionSidebar } from "./session/session-sidebar.js";
import { setupSettingsPanel } from "./settings/settings-panel.js";
import { createSkillsGlobalClient } from "./settings/skills-runtime-client.js";
import { HostControlGateway } from "./transport/control-gateway.js";
import { HostDataGateway } from "./transport/data-gateway.js";
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

function createLazyHomeSkillsClient({ fetchImpl, location }) {
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

  return createSkillsGlobalClient({
    control: {
      skillManagementRequest: (request, options) =>
        getControl().then((control) => control.skillManagementRequest(request, options)),
    },
    getCwd: () => "",
  });
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
} = {}) {
  applyTheme(getCurrentTheme());
  await initI18n();
  showHomeShell();

  const data = new HostDataGateway(null, { fetchImpl, location });
  const globalSkillsClient = createLazyHomeSkillsClient({ fetchImpl, location });
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

  setupSettingsPanel({ globalSkillsClient });
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
