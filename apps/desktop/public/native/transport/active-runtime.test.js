import { describe, expect, it, vi } from "vitest";
import {
  getActiveRuntime,
  setActiveRuntime,
  setupActiveRuntimeTracking,
} from "./active-runtime.js";

const target = {
  workspaceId: "workspace-a",
  sessionId: "session-a",
  instanceId: "instance-a",
};

describe("active runtime transport", () => {
  it("reads and updates the Host active runtime contract", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ target })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ target })));
    const location = { origin: "http://127.0.0.1:57620" };

    await expect(getActiveRuntime({ fetchImpl, location })).resolves.toEqual(target);
    await expect(setActiveRuntime(target, { fetchImpl, location })).resolves.toBe(true);

    expect(fetchImpl.mock.calls[0][0].toString()).toBe("http://127.0.0.1:57620/v2/active-runtime");
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(target),
    });
  });

  it("marks the current target again whenever its window regains focus", async () => {
    const eventTarget = new EventTarget();
    const setActive = vi.fn().mockResolvedValue(true);
    const tracking = setupActiveRuntimeTracking({
      getTarget: () => target,
      eventTarget,
      setActive,
    });

    await tracking.sync();
    eventTarget.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(setActive).toHaveBeenCalledTimes(2));

    tracking.destroy();
    eventTarget.dispatchEvent(new Event("focus"));
    expect(setActive).toHaveBeenCalledTimes(2);
  });
});
