// ABOUTME: Typed command facade for the OMP-native Skill Management RPC surface.
// ABOUTME: Keeps Desktop and browser clients on RuntimeGateway and returns only authoritative RPC data.

import { randomId } from "../utils/random-id.js";

const MUTATIONS = new Set([
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
]);

function responseData(frame) {
  return frame?.response?.data ?? frame?.data ?? frame;
}

export function createSkillsRuntimeClient({ runtime, getTarget, createId = randomId }) {
  async function call(type, params = {}) {
    const target = getTarget?.();
    if (!runtime || !target) throw new Error("Skill Management requires an active runtime session");
    const options = MUTATIONS.has(type) ? { idempotencyKey: createId() } : undefined;
    const frame = await runtime.request({ type, ...params }, target, options);
    return responseData(frame);
  }

  return {
    call,
    catalogList: (query) => call("skills_catalog_list", query ? { query } : undefined),
    catalogGet: (skillId) => call("skills_catalog_get", { skillId }),
    catalogRescan: () => call("skills_catalog_rescan"),
    collectionsList: () => call("skills_collection_list"),
    collectionGet: (collectionId) => call("skills_collection_get", { collectionId }),
    collectionCreate: ({ expectedRevision, ...params }) =>
      call("skills_collection_create", { params, expectedRevision }),
    collectionUpdate: ({ expectedRevision, ...params }) =>
      call("skills_collection_update", { params, expectedRevision }),
    collectionDelete: (params) => call("skills_collection_delete", params),
    collectionSetDefault: (params) => call("skills_collection_set_default", params),
    sessionGet: () => call("session_skills_get"),
    sessionSetBaseCollection: (params) => call("session_skills_set_base_collection", params),
    sessionAddCollection: (params) => call("session_skills_add_collection", params),
    sessionRemoveCollection: (params) => call("session_skills_remove_collection", params),
    sessionAdd: (params) => call("session_skills_add", params),
    sessionDisable: (params) => call("session_skills_disable", params),
    sessionRestore: (params) => call("session_skills_restore", params),
    sessionActivate: (params) => call("session_skills_activate", params),
    sessionSyncPreview: () => call("session_skills_sync_preview"),
    sessionSync: (params) => call("session_skills_sync", params),
    sessionRefresh: () => call("session_skills_refresh"),
  };
}
