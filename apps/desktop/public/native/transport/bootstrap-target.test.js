import { describe, expect, it, vi } from "vitest";
import { createBootstrapError, resolveBootstrapTarget } from "./bootstrap-target.js";

const temporaryRoute = {
  name: "session",
  workspaceId: "workspace-a",
  sessionId: "temporary-stale",
};

describe("createBootstrapError", () => {
  it("maps a missing saved session to a localized, deduplicated load error", () => {
    const route = { ...temporaryRoute, sessionId: "saved-session" };

    const error = createBootstrapError(route, 404, "session_not_found", "Session unavailable");

    expect(error).toMatchObject({
      message: "Session unavailable",
      status: 404,
      code: "session_not_found",
      sessionLoadKey: "session-load:workspace-a:saved-session:session_not_found",
    });
  });

  it("keeps the existing generic message for other bootstrap failures", () => {
    const error = createBootstrapError(temporaryRoute, 503, "runtime_unavailable", "Ignored");

    expect(error.message).toBe("This Picot runtime is stopped or unavailable");
    expect(error.sessionLoadKey).toBe(
      "session-load:workspace-a:temporary-stale:runtime_unavailable",
    );
  });
});

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
