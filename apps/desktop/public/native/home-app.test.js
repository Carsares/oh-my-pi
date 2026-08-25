import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startHomeApp } from "./home-app.js";

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

test("home redirects to the most recently active runtime", async () => {
  const fetchImpl = vi.fn(async (input) => {
    if (String(input) === "http://127.0.0.1:57620/v2/active-runtime") {
      return new Response(
        JSON.stringify({
          target: {
            workspaceId: "workspace-a",
            sessionId: "session-a",
            instanceId: "instance-a",
          },
        }),
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  const navigate = vi.fn();

  const result = await startHomeApp({
    fetchImpl,
    location: { origin: "http://127.0.0.1:57620" },
    navigate,
  });

  expect(navigate).toHaveBeenCalledWith("/app/workspaces/workspace-a/sessions/session-a");
  expect(result).toEqual({ sidebar: null, redirected: true });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
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
