import { describe, expect, it } from "vitest";
import { createSessionStore, reduceSessionState } from "./session-store.js";

const target = {
  workspaceId: "workspace-a",
  sessionId: "session-a",
  instanceId: "instance-a",
};

describe("session store", () => {
  it("applies contiguous events immutably and detects sequence gaps", () => {
    const initial = createSessionStore(target);
    const first = reduceSessionState(initial, {
      type: "runtime_event",
      target,
      sequence: 1,
      event: { type: "agent_start" },
    });
    expect(initial.lifecycle).toBe("starting");
    expect(first.lifecycle).toBe("working");
    expect(first.sequence).toBe(1);

    const gap = reduceSessionState(first, {
      type: "runtime_event",
      target,
      sequence: 3,
      event: { type: "agent_end" },
    });
    expect(gap).toMatchObject({ sequence: 1, snapshotRequired: true });
  });

  it("hydrates authoritative state and ignores another session", () => {
    const initial = createSessionStore(target);
    const hydrated = reduceSessionState(initial, {
      type: "runtime_snapshot",
      target,
      sequence: 7,
      state: { lifecycle: "idle", queue: { steering: ["one"], followUp: [] } },
    });
    expect(hydrated).toMatchObject({ lifecycle: "idle", sequence: 7, snapshotRequired: false });
    expect(hydrated.queue.steering).toEqual(["one"]);

    const unchanged = reduceSessionState(hydrated, {
      type: "runtime_event",
      target: { ...target, sessionId: "session-b" },
      sequence: 8,
      event: { type: "agent_start" },
    });
    expect(unchanged).toBe(hydrated);
  });

  it("keeps maintenance runs working until the terminal agent end", () => {
    const initial = createSessionStore(target);
    const working = reduceSessionState(initial, {
      type: "runtime_event",
      target,
      sequence: 1,
      event: { type: "agent_start" },
    });
    const maintenanceEnd = reduceSessionState(working, {
      type: "runtime_event",
      target,
      sequence: 2,
      event: { type: "agent_end", isTerminal: false },
    });
    const terminalEnd = reduceSessionState(maintenanceEnd, {
      type: "runtime_event",
      target,
      sequence: 3,
      event: { type: "agent_end", isTerminal: true },
    });

    expect(maintenanceEnd.lifecycle).toBe("working");
    expect(terminalEnd.lifecycle).toBe("idle");
  });

  it("maps OMP maintenance and configuration side-channel events", () => {
    const initial = createSessionStore(target);
    const compacting = reduceSessionState(initial, {
      type: "runtime_event",
      target,
      sequence: 1,
      event: { type: "auto_compaction_start" },
    });
    const configured = reduceSessionState(compacting, {
      type: "runtime_event",
      target,
      sequence: 2,
      event: {
        type: "config_update",
        model: { provider: "openai", id: "gpt-5" },
        thinkingLevel: "high",
      },
    });

    expect(compacting.compaction).toEqual({ status: "running" });
    expect(configured.model).toEqual({ provider: "openai", id: "gpt-5" });
    expect(configured.thinkingLevel).toBe("high");
  });
});
