import { describe, expect, it, vi } from "vitest";
import { resolveBootstrapTarget } from "./bootstrap-target.js";

const temporaryRoute = {
  name: "session",
  workspaceId: "workspace-a",
  sessionId: "temporary-stale",
};

describe("resolveBootstrapTarget", () => {
  it("replaces a missing temporary runtime with a new runtime in the same workspace", async () => {
    const requestTarget = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
    const spawned = {
      workspaceId: "workspace-a",
      sessionId: "temporary-new",
      instanceId: "instance-new",
    };
    const spawnTemporarySession = vi.fn().mockResolvedValue(spawned);

    await expect(
      resolveBootstrapTarget({ route: temporaryRoute, requestTarget, spawnTemporarySession }),
    ).resolves.toEqual(spawned);
    expect(spawnTemporarySession).toHaveBeenCalledWith("workspace-a");
  });

  it("does not replace a missing persisted session", async () => {
    const requestTarget = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
    const spawnTemporarySession = vi.fn();

    await expect(
      resolveBootstrapTarget({
        route: { ...temporaryRoute, sessionId: "saved-session" },
        requestTarget,
        spawnTemporarySession,
      }),
    ).rejects.toThrow("Not found");
    expect(spawnTemporarySession).not.toHaveBeenCalled();
  });

  it("does not hide bootstrap failures other than a missing temporary runtime", async () => {
    const requestTarget = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("Host unavailable"), { status: 500 }));
    const spawnTemporarySession = vi.fn();

    await expect(
      resolveBootstrapTarget({ route: temporaryRoute, requestTarget, spawnTemporarySession }),
    ).rejects.toThrow("Host unavailable");
    expect(spawnTemporarySession).not.toHaveBeenCalled();
  });
});
