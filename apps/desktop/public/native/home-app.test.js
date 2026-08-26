import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openHomeSession, startHomeApp } from "./home-app.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

beforeEach(() => {
  const fixture = new DOMParser().parseFromString(
    readFileSync(join(process.cwd(), "public/index.html"), "utf8"),
    "text/html",
  );
  document.documentElement.replaceChildren(...fixture.documentElement.childNodes);
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  sessionStorage.clear();
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
