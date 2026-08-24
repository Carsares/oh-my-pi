// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./super-agent-entry.js";

describe("super-agent-entry compatibility", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("dispatches the Agent Inbox navigation event instead of opening a workspace", async () => {
    const openAgentInbox = vi.fn();
    const openRuntime = vi.fn();
    document.addEventListener("sa-open-agent-inbox", openAgentInbox);
    document.addEventListener("sa-open-runtime", openRuntime);
    const transport = {
      newSession: vi.fn(),
      openWorkspace: vi.fn(),
    };

    window.__saNav = {
      transport,
    };

    const Entry = customElements.get("super-agent-entry");
    const entry = new Entry();
    document.body.appendChild(entry);

    await entry._open();

    expect(openAgentInbox).toHaveBeenCalledTimes(1);
    expect(openRuntime).toHaveBeenCalledTimes(1);
    expect(transport.newSession).not.toHaveBeenCalled();
    expect(transport.openWorkspace).not.toHaveBeenCalled();
  });
});
