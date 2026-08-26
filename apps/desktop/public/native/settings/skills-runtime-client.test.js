import { describe, expect, it, vi } from "vitest";
import { createSkillsRuntimeClient } from "./skills-runtime-client.js";

const target = { workspaceId: "workspace-a", sessionId: "session-a", instanceId: "instance-a" };

describe("createSkillsRuntimeClient", () => {
  it("unwraps authoritative OMP data and adds transport idempotency only to mutations", async () => {
    const runtime = {
      request: vi.fn(async (command) => ({
        response: { success: true, data: { command: command.type } },
      })),
    };
    const client = createSkillsRuntimeClient({
      runtime,
      getTarget: () => target,
      createId: () => "intent-a",
    });

    await expect(client.catalogList({ status: "available" })).resolves.toEqual({
      command: "skills_catalog_list",
    });
    await expect(
      client.collectionCreate({
        name: "Collection A",
        expectedRevision: 4,
      }),
    ).resolves.toEqual({ command: "skills_collection_create" });
    await expect(
      client.collectionUpdate({
        collectionId: "collection-a",
        patch: { name: "Renamed" },
        expectedRevision: 5,
      }),
    ).resolves.toEqual({ command: "skills_collection_update" });
    expect(runtime.request).toHaveBeenNthCalledWith(
      1,
      { type: "skills_catalog_list", query: { status: "available" } },
      target,
      undefined,
    );
    expect(runtime.request).toHaveBeenNthCalledWith(
      2,
      {
        type: "skills_collection_create",
        params: { name: "Collection A" },
        expectedRevision: 4,
      },
      target,
      { idempotencyKey: "intent-a" },
    );
    expect(runtime.request).toHaveBeenNthCalledWith(
      3,
      {
        type: "skills_collection_update",
        params: { collectionId: "collection-a", patch: { name: "Renamed" } },
        expectedRevision: 5,
      },
      target,
      { idempotencyKey: "intent-a" },
    );
  });

  it("uses the runtime target for session commands without duplicating session identity", async () => {
    const runtime = { request: vi.fn(async () => ({ response: { data: { ok: true } } })) };
    const client = createSkillsRuntimeClient({
      runtime,
      getTarget: () => target,
      createId: () => "intent-a",
    });
    await client.sessionDisable({ skillId: "skill-a", expectedRevision: 3 });
    expect(runtime.request).toHaveBeenCalledWith(
      {
        type: "session_skills_disable",
        skillId: "skill-a",
        expectedRevision: 3,
      },
      target,
      { idempotencyKey: "intent-a" },
    );
  });

  it("sends preview and refresh without command parameters", async () => {
    const runtime = { request: vi.fn(async () => ({ response: { data: { ok: true } } })) };
    const client = createSkillsRuntimeClient({
      runtime,
      getTarget: () => target,
      createId: () => "intent-a",
    });

    await client.sessionSyncPreview();
    await client.sessionRefresh();

    expect(runtime.request).toHaveBeenNthCalledWith(
      1,
      { type: "session_skills_sync_preview" },
      target,
      undefined,
    );
    expect(runtime.request).toHaveBeenNthCalledWith(2, { type: "session_skills_refresh" }, target, {
      idempotencyKey: "intent-a",
    });
  });
});
