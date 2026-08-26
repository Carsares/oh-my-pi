import { describe, expect, it } from "vitest";
import { createInMemoryRuntimeAdapter, RuntimeGateway } from "./runtime-gateway.js";

const target = {
  workspaceId: "workspace-a",
  sessionId: "session-a",
  instanceId: "instance-a",
};

describe("RuntimeGateway", () => {
  it("requires identity and an idempotency key for mutations", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const gateway = new RuntimeGateway(adapter);

    await expect(gateway.request({ type: "prompt", message: "hi" }, target)).rejects.toThrow(
      "idempotencyKey",
    );
    const request = gateway.request({ type: "prompt", message: "hi" }, target, {
      idempotencyKey: "intent-1",
    });
    const frame = adapter.takeSent();
    expect(frame.type).toBe("runtime_request");
    expect(frame.target).toEqual(target);
    adapter.receive({
      type: "runtime_response",
      requestId: frame.requestId,
      acceptance: "accepted",
      response: { success: true },
    });
    await expect(request).resolves.toMatchObject({ acceptance: "accepted" });
  });

  it("requires idempotency keys for Skill Management mutations", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const gateway = new RuntimeGateway(adapter);

    for (const type of [
      "skills_catalog_rescan",
      "skills_collection_create",
      "skills_collection_update",
      "skills_collection_delete",
      "skills_collection_set_default",
      "session_skills_set_base_collection",
      "session_skills_add_collection",
      "session_skills_remove_collection",
      "session_skills_add",
      "session_skills_disable",
      "session_skills_restore",
      "session_skills_activate",
      "session_skills_sync",
      "session_skills_refresh",
    ]) {
      await expect(gateway.request({ type }, target)).rejects.toThrow("idempotencyKey");
    }
  });

  it("rejects pending requests on disconnect and ignores stale responses after reconnect", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const gateway = new RuntimeGateway(adapter);
    const pending = gateway.snapshot(target.sessionId);
    const oldFrame = adapter.takeSent();

    adapter.disconnect();
    await expect(pending).rejects.toThrow("disconnected");
    adapter.reconnect();
    adapter.receive({
      type: "runtime_response",
      requestId: oldFrame.requestId,
      response: { stale: true },
    });

    const fresh = gateway.snapshot(target.sessionId);
    const freshFrame = adapter.takeSent();
    adapter.receive({
      type: "runtime_snapshot",
      requestId: freshFrame.requestId,
      target,
      sequence: 4,
      state: { lifecycle: "idle" },
    });
    await expect(fresh).resolves.toMatchObject({ sequence: 4 });
  });

  it("rejects nested OMP runtime errors instead of resolving the transport envelope", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const gateway = new RuntimeGateway(adapter);
    const pending = gateway.snapshot(target.sessionId);
    const frame = adapter.takeSent();

    adapter.receive({
      type: "runtime_response",
      requestId: frame.requestId,
      acceptance: "accepted",
      response: {
        type: "response",
        command: "get_state",
        success: false,
        error: "Unknown command: get_state",
      },
    });

    await expect(pending).rejects.toThrow("Unknown command: get_state");
  });

  it("preserves domain error code and current state", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const gateway = new RuntimeGateway(adapter);
    const pending = gateway.request({ type: "session_skills_disable" }, target, {
      idempotencyKey: "intent-a",
    });
    const request = adapter.takeSent();
    adapter.receive({
      type: "runtime_response",
      requestId: request.requestId,
      response: {
        success: false,
        error: "Profile changed",
        code: "stale_profile",
        current: { revision: 4 },
      },
    });
    await expect(pending).rejects.toMatchObject({
      message: "Profile changed",
      code: "stale_profile",
      current: { revision: 4 },
    });
  });
});
