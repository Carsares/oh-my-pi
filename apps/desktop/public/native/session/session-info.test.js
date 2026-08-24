import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../i18n.js";
import englishMessages from "../../locales/en.json";
import { setupSessionInfo } from "./session-info.js";

describe("session info", () => {
  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => englishMessages }),
    );
    await initI18n();
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="toggle" aria-expanded="false"></button>
      <section id="panel" class="hidden"><span id="file"></span><span id="id"></span></section>`;
  });

  it("shows the active session file and id", () => {
    document.getElementById("toggle").getBoundingClientRect = () => ({ bottom: 40, right: 900 });
    setupSessionInfo({
      toggle: document.getElementById("toggle"),
      panel: document.getElementById("panel"),
      fileValue: document.getElementById("file"),
      idValue: document.getElementById("id"),
      getTarget: () => ({ sessionId: "session-a" }),
      getSessions: () => [{ id: "session-a", filePath: "/sessions/a.jsonl" }],
    });

    document.getElementById("toggle").click();

    expect(document.getElementById("file").textContent).toBe("/sessions/a.jsonl");
    expect(document.getElementById("id").textContent).toBe("session-a");
    expect(document.getElementById("toggle").getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("panel").parentElement).toBe(document.body);
    expect(document.getElementById("panel").style.position).toBe("fixed");
    expect(document.getElementById("panel").style.top).toBe("48px");
  });

  it("uses an in-memory label before a session file exists", () => {
    setupSessionInfo({
      toggle: document.getElementById("toggle"),
      panel: document.getElementById("panel"),
      fileValue: document.getElementById("file"),
      idValue: document.getElementById("id"),
      getTarget: () => ({ sessionId: "temporary-a" }),
      getSessions: () => [],
    });

    document.getElementById("toggle").click();
    expect(document.getElementById("file").textContent).toContain("not saved yet");
    expect(document.getElementById("id").textContent).toBe("temporary-a");
  });

  it("copies the requested session field", async () => {
    const panel = document.getElementById("panel");
    panel.insertAdjacentHTML(
      "beforeend",
      '<button data-copy-session-field="file"></button><button data-copy-session-field="id"></button>',
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    setupSessionInfo({
      toggle: document.getElementById("toggle"),
      panel,
      fileValue: document.getElementById("file"),
      idValue: document.getElementById("id"),
      getTarget: () => ({ sessionId: "session-a" }),
      getSessions: () => [{ id: "session-a", filePath: "/sessions/a.jsonl" }],
      writeText,
    });

    document.getElementById("toggle").click();
    panel.querySelector('[data-copy-session-field="file"]').click();
    panel.querySelector('[data-copy-session-field="id"]').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));

    expect(writeText).toHaveBeenNthCalledWith(1, "/sessions/a.jsonl");
    expect(writeText).toHaveBeenNthCalledWith(2, "session-a");
  });
});
