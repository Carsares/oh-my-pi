import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "../components/chat-settings-panel.js";
import { openHomeSession, startHomeApp } from "./home-app.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }
}

function createConfigGateway(overrides = {}) {
  return {
    call: vi.fn(async (operation) => {
      if (operation === "list_model_catalog") {
        return { ok: true, data: { providers: [] } };
      }
      if (operation === "read_agent_config") {
        return { ok: true, data: { content: "{}\n", path: "/tmp/config.yml" } };
      }
      if (operation === "read_models_config") {
        return {
          ok: true,
          data: { content: '{"providers": {}}\n', path: "/tmp/models.yml" },
        };
      }
      if (operation === "get_default_thinking_level") {
        return { ok: true, data: { level: "high" } };
      }
      if (operation === "get_default_auto_compaction") {
        return { ok: true, data: { enabled: true } };
      }
      return { ok: true };
    }),
    ...overrides,
  };
}

beforeEach(() => {
  const fixture = new DOMParser().parseFromString(
    readFileSync(join(process.cwd(), "public/index.html"), "utf8"),
    "text/html",
  );
  document.documentElement.replaceChildren(...fixture.documentElement.childNodes);
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  sessionStorage.clear();
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      if (String(input).includes("/locales/en.json")) {
        return new Response(JSON.stringify(enMessages));
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }),
  );
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "__TAURI__");
  Reflect.deleteProperty(window, "__picotConfigCall");
  document.documentElement.replaceChildren();
});

test("home always renders the main page without checking for an active runtime", async () => {
  const fetchImpl = vi.fn(async (input) => {
    const url = String(input);
    if (url.includes("/locales/en.json")) return new Response(JSON.stringify(enMessages));
    if (url === "http://127.0.0.1:57620/v2/sessions") {
      return new Response(JSON.stringify({ sessions: [] }));
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  const navigate = vi.fn();

  const result = await startHomeApp({
    fetchImpl,
    location: { origin: "http://127.0.0.1:57620" },
    navigate,
    configGateway: createConfigGateway(),
  });

  expect(navigate).not.toHaveBeenCalled();
  expect(result).toEqual({ sidebar: expect.any(Object), redirected: false });
  expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("/v2/active-runtime"))).toBe(
    false,
  );
  result.sidebar.destroy();
});

test("native home opens an existing session through the desktop workspace command", async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);

  await openHomeSession({ id: "session-a", projectPath: "/projects/example" }, { invoke });

  expect(invoke).toHaveBeenCalledWith("open_session_in_project", {
    projectPath: "/projects/example",
    sessionId: "session-a",
  });
});

test("home remains workspace-neutral when no runtime is active", async () => {
  const fetchImpl = vi.fn(async (input) => {
    const url = String(input);
    if (url === "http://127.0.0.1:57620/v2/active-runtime") {
      return new Response(JSON.stringify({ target: null }));
    }
    if (url.includes("/locales/en.json")) {
      return new Response(JSON.stringify(enMessages));
    }
    if (url === "http://127.0.0.1:57620/v2/sessions") {
      return new Response(
        JSON.stringify({
          sessions: [
            {
              id: "session-a",
              name: "Saved session",
              projectPath: "/projects/example",
              projectName: "example",
              workspaceId: "",
              isCurrentWorkspace: false,
            },
          ],
        }),
      );
    }
    if (url === "/health") {
      return new Response(JSON.stringify({ ompVersion: "test" }));
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchImpl);
  const webSocket = vi.fn();
  vi.stubGlobal("WebSocket", webSocket);
  const resolveWorkspace = vi.fn().mockResolvedValue("workspace-a");
  const navigate = vi.fn();

  const { sidebar, redirected } = await startHomeApp({
    fetchImpl,
    location: { origin: "http://127.0.0.1:57620" },
    resolveWorkspace,
    navigate,
    configGateway: createConfigGateway(),
  });

  expect(redirected).toBe(false);
  expect(document.body.dataset.route).toBe("home");
  expect(document.querySelector(".session-header").classList).toContain("hidden");
  expect(document.querySelector(".input-area").classList).toContain("hidden");
  expect(document.querySelector(".session-title").textContent).toBe("Saved session");
  expect(webSocket).not.toHaveBeenCalled();
  expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("/v2/bootstrap"))).toBe(
    false,
  );

  document.querySelector(".session-item").click();
  await vi.waitFor(() => {
    expect(resolveWorkspace).toHaveBeenCalledWith("/projects/example");
    expect(navigate).toHaveBeenCalledWith("/app/workspaces/workspace-a/sessions/session-a");
  });

  document.getElementById("settings-btn").click();
  expect(document.getElementById("settings-panel").classList).not.toContain("hidden");
  expect(document.querySelector("#settings-close span").textContent).toBe("Back");
  sidebar.destroy();
});

test("home configuration loads providers without creating a session runtime", async () => {
  const fetchImpl = vi.fn(async (input) => {
    const url = String(input);
    if (url.includes("/locales/en.json")) return new Response(JSON.stringify(enMessages));
    if (url === "http://127.0.0.1:57620/v2/sessions") {
      return new Response(JSON.stringify({ sessions: [] }));
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  const configGateway = createConfigGateway({
    call: vi.fn(async (operation) => {
      if (operation === "list_model_catalog") {
        return {
          ok: true,
          data: {
            providers: [
              {
                provider: "openai",
                displayName: "OpenAI",
                configured: true,
                models: [],
              },
            ],
          },
        };
      }
      if (operation === "read_agent_config") {
        return { ok: true, data: { content: "{}\n", path: "/tmp/config.yml" } };
      }
      if (operation === "read_models_config") {
        return {
          ok: true,
          data: { content: '{"providers": {}}\n', path: "/tmp/models.yml" },
        };
      }
      if (operation === "get_default_thinking_level") {
        return { ok: true, data: { level: "high" } };
      }
      if (operation === "get_default_auto_compaction") {
        return { ok: true, data: { enabled: true } };
      }
      return { ok: true };
    }),
  });

  const { sidebar } = await startHomeApp({
    fetchImpl,
    location: { origin: "http://127.0.0.1:57620" },
    configGateway,
  });
  document.getElementById("settings-btn").click();
  document.querySelector('[data-settings-tab="configuration"]').click();

  await vi.waitFor(() => {
    expect(configGateway.call).toHaveBeenCalledWith("list_model_catalog", undefined, undefined);
    expect(document.getElementById("settings-api-keys").textContent).toContain("OpenAI");
    expect(document.getElementById("settings-api-keys").textContent).not.toContain(
      "Loading providers",
    );
  });
  expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("/v2/bootstrap"))).toBe(
    false,
  );
  sidebar.destroy();
});

test("home manages global extensions through the lazy host connection without a runtime", async () => {
  const fetchImpl = vi.fn(async (input) => {
    const url = String(input);
    if (url.includes("/locales/en.json")) return new Response(JSON.stringify(enMessages));
    if (url === "http://127.0.0.1:57620/v2/sessions") {
      return new Response(JSON.stringify({ sessions: [] }));
    }
    if (url.startsWith("https://pi-packages-api.shixin.workers.dev/packages")) {
      return new Response(
        JSON.stringify({
          packages: [{ name: "example-plugin", description: "Example", types: [] }],
          totalPages: 1,
        }),
      );
    }
    if (url === "/health") return new Response(JSON.stringify({ ompVersion: "test" }));
    return new Response(JSON.stringify({}), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchImpl);
  vi.stubGlobal("WebSocket", FakeWebSocket);

  const { sidebar } = await startHomeApp({
    fetchImpl,
    location: {
      href: "http://127.0.0.1:57620/",
      origin: "http://127.0.0.1:57620",
      protocol: "http:",
      host: "127.0.0.1:57620",
      hostname: "127.0.0.1",
    },
    configGateway: createConfigGateway(),
  });

  document.getElementById("sidebar-extensions-btn").click();
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({ type: "hello_ack", protocolVersion: 2 });

  let installedRequest;
  await vi.waitFor(() => {
    installedRequest = socket.sent.find(
      (frame) => frame.type === "host_request" && frame.operation === "list_omp_plugins",
    );
    expect(installedRequest).toMatchObject({ cwd: "" });
  });
  socket.receive({
    type: "host_response",
    requestId: installedRequest.requestId,
    plugins: { npm: [], marketplace: [] },
  });
  await vi.waitFor(() => {
    const managerText = document.getElementById("pkg-manager-groups").textContent;
    expect(managerText).toContain(enMessages.extensions.noInstalled);
    expect(managerText).not.toContain(enMessages.extensions.managementUnavailable);
  });

  document.getElementById("settings-btn").click();
  document.querySelector('[data-settings-tab="extensions"]').click();
  let catalogInstalledRequest;
  await vi.waitFor(() => {
    const requests = socket.sent.filter(
      (frame) => frame.type === "host_request" && frame.operation === "list_omp_plugins",
    );
    expect(requests).toHaveLength(2);
    catalogInstalledRequest = requests[1];
  });
  socket.receive({
    type: "host_response",
    requestId: catalogInstalledRequest.requestId,
    plugins: { npm: [], marketplace: [] },
  });

  let installButton;
  await vi.waitFor(() => {
    installButton = document.querySelector(".pkg-browse-row .settings-value-btn");
    expect(installButton?.textContent).toBe(enMessages.actions.install);
  });
  installButton.click();
  let installRequest;
  await vi.waitFor(() => {
    installRequest = socket.sent.find(
      (frame) => frame.type === "host_request" && frame.operation === "install_omp_plugin",
    );
    expect(installRequest).toMatchObject({ pluginSource: "npm:example-plugin", cwd: "" });
  });
  socket.receive({ type: "host_response", requestId: installRequest.requestId });
  await vi.waitFor(() => {
    expect(document.querySelector(".pkg-browse-row .settings-value-btn")?.textContent).toBe(
      enMessages.actions.uninstall,
    );
  });

  expect(socket.sent.some((frame) => frame.type.startsWith("runtime_"))).toBe(false);
  sidebar.destroy();
});

test("native home initializes the existing updater check", async () => {
  const check = vi.fn(async () => null);
  globalThis.__TAURI__ = { updater: { check } };
  const fetchImpl = vi.fn(async (input) => {
    const url = String(input);
    if (url.includes("/locales/en.json")) return new Response(JSON.stringify(enMessages));
    if (url === "http://127.0.0.1:57620/v2/sessions") {
      return new Response(JSON.stringify({ sessions: [] }));
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });

  const { sidebar } = await startHomeApp({
    fetchImpl,
    location: { origin: "http://127.0.0.1:57620" },
    configGateway: createConfigGateway(),
  });

  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
  document.getElementById("btn-check-updates").click();
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
  sidebar.destroy();
});

test("home Agent Inbox loads through Host configuration without a session runtime", async () => {
  const fetchImpl = vi.fn(async (input) => {
    const url = String(input);
    if (url.includes("/locales/en.json")) return new Response(JSON.stringify(enMessages));
    if (url === "http://127.0.0.1:57620/v2/sessions") {
      return new Response(JSON.stringify({ sessions: [] }));
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  const configGateway = createConfigGateway({
    call: vi.fn(async (operation) => {
      if (operation === "read_chat_config") {
        return {
          ok: true,
          data: { content: '{"accounts":{}}', path: "/tmp/chat/config.json" },
        };
      }
      if (operation === "telegram_doctor") {
        return {
          ok: true,
          data: { report: { summary: "warning", checks: [] } },
        };
      }
      if (operation === "get_default_thinking_level") {
        return { ok: true, data: { level: "high" } };
      }
      if (operation === "get_default_auto_compaction") {
        return { ok: true, data: { enabled: true } };
      }
      return { ok: true };
    }),
  });

  const { sidebar } = await startHomeApp({
    fetchImpl,
    location: { origin: "http://127.0.0.1:57620" },
    configGateway,
  });
  document.getElementById("settings-btn").click();
  document.querySelector('[data-settings-tab="chat"]').click();

  await vi.waitFor(() => {
    expect(configGateway.call).toHaveBeenCalledWith("read_chat_config", {}, {});
    expect(configGateway.call).toHaveBeenCalledWith("telegram_doctor", {}, {});
    expect(document.querySelector("chat-settings-panel [data-textarea]").value).toBe(
      '{"accounts":{}}',
    );
  });
  expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("/v2/bootstrap"))).toBe(
    false,
  );
  sidebar.destroy();
});
