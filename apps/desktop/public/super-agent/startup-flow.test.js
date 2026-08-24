import { describe, expect, it } from "vitest";

import { hasSuperAgentSession, selectSuperAgentStartupAction } from "./startup-flow.js";

describe("super agent startup flow", () => {
  it("ensures the Agent Inbox exists when autostart is enabled on a fresh machine", () => {
    expect(
      selectSuperAgentStartupAction({
        enabled: true,
        sessions: [{ id: "project", projectPath: "/Users/me/project" }],
      }),
    ).toEqual({ type: "ensure" });
  });

  it("launches the latest existing Agent Inbox session", () => {
    const action = selectSuperAgentStartupAction({
      enabled: true,
      sessions: [
        { id: "old", projectPath: "/Users/me/.pi/agent/super-agent", timestamp: 10 },
        { id: "new", projectPath: "/Users/me/.pi/agent/super-agent", timestamp: 20 },
      ],
    });

    expect(action).toEqual({
      type: "launch",
      session: expect.objectContaining({ id: "new" }),
    });
  });

  it("does nothing when already on Agent Inbox", () => {
    expect(
      selectSuperAgentStartupAction({
        enabled: true,
        currentSessionId: "agent",
        sessions: [{ id: "agent", kind: "super-agent" }],
      }),
    ).toEqual({ type: "none" });
  });

  it("detects conventional Agent Inbox sessions", () => {
    expect(hasSuperAgentSession([{ projectPath: "/Users/me/.pi/agent/super-agent" }])).toBe(true);
    expect(hasSuperAgentSession([{ projectPath: "/Users/me/project" }])).toBe(false);
  });
});
