// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { dispatchSuperAgentTaskNative } from "./native-dispatch.js";

function makeTask(overrides = {}) {
  return {
    id: "task-1",
    status: "running",
    title: "Fix the thing",
    targetProject: "/Users/me/project",
    ...overrides,
  };
}

describe("dispatchSuperAgentTaskNative", () => {
  it("resolves workspace, spawns a session, and prompts the child target", async () => {
    const resolveWorkspace = vi.fn().mockResolvedValue("workspace-a");
    const spawnSession = vi.fn().mockResolvedValue({
      workspaceId: "workspace-a",
      sessionId: "temporary-abc",
      instanceId: "instance-a",
    });
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    const resolveBoundTarget = vi.fn().mockResolvedValue({
      workspaceId: "workspace-a",
      sessionId: "session-formal",
      instanceId: "instance-a",
    });
    const updates = [];
    let currentTask = makeTask();
    const updateTask = vi.fn(async (_taskId, updater) => {
      currentTask = updater(currentTask);
      updates.push(currentTask);
      return currentTask;
    });
    const registerDispatchTarget = vi.fn();

    const result = await dispatchSuperAgentTaskNative({
      task: makeTask(),
      resolveWorkspace,
      spawnSession,
      sendPrompt,
      resolveBoundTarget,
      updateTask,
      registerDispatchTarget,
      logger: { error: vi.fn(), warn: vi.fn() },
    });

    expect(resolveWorkspace).toHaveBeenCalledWith("/Users/me/project");
    expect(spawnSession).toHaveBeenCalledWith("workspace-a");
    expect(registerDispatchTarget).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "instance-a" }),
      "task-1",
    );
    expect(sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "instance-a" }),
      expect.stringContaining("Task ID: task-1"),
      expect.any(Object),
    );
    expect(resolveBoundTarget).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "temporary-abc" }),
    );
    expect(updates.at(-1).dispatch).toMatchObject({
      childWorkspaceId: "workspace-a",
      childInstanceId: "instance-a",
      childSessionId: "session-formal",
    });
    expect(result?.target).toMatchObject({
      instanceId: "instance-a",
      sessionId: "session-formal",
    });
  });

  it("skips tasks without a target project", async () => {
    const resolveWorkspace = vi.fn();
    const result = await dispatchSuperAgentTaskNative({
      task: makeTask({ targetProject: null, dispatch: { targetProject: null } }),
      resolveWorkspace,
      spawnSession: vi.fn(),
      sendPrompt: vi.fn(),
      updateTask: vi.fn(),
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    expect(result).toBeNull();
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });

  it("marks the task failed when the prompt is rejected", async () => {
    const updates = [];
    const updateTask = vi.fn(async (_taskId, updater) => {
      const next = updater(
        makeTask({ dispatch: { childWorkspaceId: "workspace-a", childInstanceId: "instance-a" } }),
      );
      updates.push(next);
      return next;
    });

    const result = await dispatchSuperAgentTaskNative({
      task: makeTask(),
      resolveWorkspace: vi.fn().mockResolvedValue("workspace-a"),
      spawnSession: vi.fn().mockResolvedValue({
        workspaceId: "workspace-a",
        sessionId: "temporary-abc",
        instanceId: "instance-a",
      }),
      sendPrompt: vi.fn().mockRejectedValue(new Error("No active session")),
      updateTask,
      logger: { error: vi.fn(), warn: vi.fn() },
    });

    expect(result).toBeNull();
    expect(updates.at(-1)).toMatchObject({ status: "failed", failReason: "No active session" });
  });
});
