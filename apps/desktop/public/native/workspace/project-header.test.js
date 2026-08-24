import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n.js";
import { setupProjectHeader } from "./project-header.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));
const BASE_HTML = `
  <button id="file-sidebar-toggle" class="file-sidebar-toggle" title="Files" aria-label="Toggle file browser">
    <span id="workspace-indicator" class="file-sidebar-toggle__label hidden"></span>
  </button>
  <button id="diff-sidebar-toggle" class="git-branch-toggle hidden">
    <span id="git-branch-indicator" class="git-branch-toggle__label"></span>
  </button>
`;

describe("project header", () => {
  beforeEach(async () => {
    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).includes("/locales/")) {
        return { ok: true, json: async () => enMessages };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await initI18n();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("shows the full workspace path in the files toggle", async () => {
    document.body.innerHTML = BASE_HTML;
    const fullPath = "/Users/ShixinGuo/code/pi/pi-web-ui";
    const data = {
      workspaceInfo: vi.fn().mockResolvedValue({ info: { path: fullPath } }),
    };

    await setupProjectHeader({ data, workspaceId: "workspace-a" });

    const indicator = document.getElementById("workspace-indicator");
    const toggle = document.getElementById("file-sidebar-toggle");
    expect(data.workspaceInfo).toHaveBeenCalledWith("workspace-a");
    expect(indicator.textContent).toBe(fullPath);
    expect(indicator.classList.contains("hidden")).toBe(false);
    expect(toggle.title).toBe(fullPath);
    expect(toggle.getAttribute("aria-label")).toBe(`Open Files panel — ${fullPath}`);
  });

  it("shows git branch toggle with branch name when git info is available", async () => {
    document.body.innerHTML = BASE_HTML;
    const data = {
      workspaceInfo: vi.fn().mockResolvedValue({
        info: { path: "/some/path", gitBranch: "main" },
      }),
    };

    await setupProjectHeader({ data, workspaceId: "workspace-b" });

    const toggle = document.getElementById("diff-sidebar-toggle");
    const label = document.getElementById("git-branch-indicator");
    expect(toggle.classList.contains("hidden")).toBe(false);
    expect(label.textContent).toBe("main");
    expect(toggle.title).toContain("main");
  });

  it("hides git branch toggle when project has no git info", async () => {
    document.body.innerHTML = BASE_HTML;
    const data = {
      workspaceInfo: vi.fn().mockResolvedValue({
        info: { path: "/some/non-git-path" },
      }),
    };

    await setupProjectHeader({ data, workspaceId: "workspace-c" });

    const toggle = document.getElementById("diff-sidebar-toggle");
    expect(toggle.classList.contains("hidden")).toBe(true);
  });

  it("leaves the path label hidden when workspace path is unavailable", async () => {
    document.body.innerHTML = BASE_HTML;
    const data = {
      workspaceInfo: vi.fn().mockResolvedValue({ info: { gitBranch: "main" } }),
    };

    await setupProjectHeader({ data, workspaceId: "workspace-d" });

    const indicator = document.getElementById("workspace-indicator");
    const toggle = document.getElementById("file-sidebar-toggle");
    expect(indicator.classList.contains("hidden")).toBe(true);
    expect(indicator.textContent).toBe("");
    expect(toggle.title).toBe("Files");
    expect(toggle.getAttribute("aria-label")).toBe("Toggle file browser");
  });
});
