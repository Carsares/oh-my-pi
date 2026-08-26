import { describe, expect, test } from "bun:test";
import { handleSkillManagementRpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type {
	RpcSkillManagementCommand,
	RpcSkillManagementUpdateFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { SkillManagementError } from "@oh-my-pi/pi-coding-agent/skills-management/errors";
import type { SkillManagementService } from "@oh-my-pi/pi-coding-agent/skills-management/service";

type ServiceMethod = keyof SkillManagementService;

function serviceRecorder(
	calls: Array<{ method: ServiceMethod; args: unknown[] }>,
	result: object,
): SkillManagementService {
	return new Proxy(
		{},
		{
			get(_target, property) {
				return async (...args: unknown[]) => {
					calls.push({ method: property as ServiceMethod, args });
					return result;
				};
			},
		},
	) as SkillManagementService;
}

const collectionParams = {
	name: "Review",
	skillIds: ["skill-a"],
};
const collectionId = "10000000-0000-4000-8000-000000000001";
const collectionPatch = { collectionId, patch: { name: "Updated" } };
const sessionContext = { expectedActiveLeafId: "leaf-1", expectedRevision: 3 };
const previewRevisions = { expectedProfileRevision: 3, expectedCollectionsRevision: 4, expectedCatalogRevision: 5 };

const cases: Array<{
	command: RpcSkillManagementCommand;
	method: ServiceMethod;
	args: unknown[];
	event?: RpcSkillManagementUpdateFrame;
}> = [
	{
		command: { id: "1", type: "skills_catalog_list", query: { name: "review" } },
		method: "listCatalog",
		args: [{ name: "review" }],
	},
	{
		command: { id: "2", type: "skills_catalog_get", skillId: "skill-a" },
		method: "getCatalogEntry",
		args: ["skill-a"],
	},
	{
		command: { id: "3", type: "skills_catalog_rescan" },
		method: "rescanCatalog",
		args: [],
		event: { type: "skills_catalog_update" },
	},
	{ command: { id: "4", type: "skills_collection_list" }, method: "listCollections", args: [] },
	{
		command: { id: "5", type: "skills_collection_get", collectionId },
		method: "getCollection",
		args: [collectionId],
	},
	{
		command: { id: "6", type: "skills_collection_create", params: collectionParams, expectedRevision: 4 },
		method: "createCollection",
		args: [collectionParams, { expectedRevision: 4 }],
		event: { type: "skills_collections_update" },
	},
	{
		command: { id: "7", type: "skills_collection_update", params: collectionPatch, expectedRevision: 4 },
		method: "updateCollection",
		args: [collectionPatch, { expectedRevision: 4 }],
		event: { type: "skills_collections_update" },
	},
	{
		command: {
			id: "8",
			type: "skills_collection_delete",
			collectionId,
			expectedRevision: 4,
		},
		method: "deleteCollection",
		args: [collectionId, { expectedRevision: 4 }],
		event: { type: "skills_collections_update" },
	},
	{
		command: {
			id: "9",
			type: "skills_collection_set_default",
			collectionId,
			expectedRevision: 4,
		},
		method: "setDefaultCollection",
		args: [collectionId, { expectedRevision: 4 }],
		event: { type: "skills_collections_update" },
	},
	{ command: { id: "10", type: "session_skills_get" }, method: "getSessionSkills", args: [] },
	{
		command: {
			id: "11",
			type: "session_skills_set_base_collection",
			collectionId,
			...sessionContext,
		},
		method: "setBaseCollection",
		args: [collectionId, sessionContext],
		event: { type: "session_skills_update" },
	},
	{
		command: {
			id: "12",
			type: "session_skills_add_collection",
			collectionId,
			...sessionContext,
		},
		method: "addCollection",
		args: [collectionId, sessionContext],
		event: { type: "session_skills_update" },
	},
	{
		command: {
			id: "13",
			type: "session_skills_remove_collection",
			collectionId,
			...sessionContext,
		},
		method: "removeCollection",
		args: [collectionId, sessionContext],
		event: { type: "session_skills_update" },
	},
	{
		command: { id: "14", type: "session_skills_add", skillId: "skill-a", ...sessionContext },
		method: "addSessionSkill",
		args: ["skill-a", sessionContext],
		event: { type: "session_skills_update" },
	},
	{
		command: { id: "15", type: "session_skills_disable", skillId: "skill-a", ...sessionContext },
		method: "disableSessionSkill",
		args: ["skill-a", sessionContext],
		event: { type: "session_skills_update" },
	},
	{
		command: { id: "16", type: "session_skills_restore", skillId: "skill-a", ...sessionContext },
		method: "restoreSessionSkill",
		args: ["skill-a", sessionContext],
		event: { type: "session_skills_update" },
	},
	{
		command: { id: "17", type: "session_skills_activate", skillId: "skill-a", ...sessionContext },
		method: "activateSessionSkill",
		args: ["skill-a", sessionContext],
		event: { type: "session_skills_update" },
	},
	{ command: { id: "18", type: "session_skills_sync_preview" }, method: "previewSessionSync", args: [] },
	{
		command: { id: "19", type: "session_skills_sync", previewRevisions, ...sessionContext },
		method: "syncSessionSkills",
		args: [previewRevisions, sessionContext],
		event: { type: "session_skills_update" },
	},
	{
		command: { id: "20", type: "session_skills_refresh" },
		method: "refreshSessionSkills",
		args: [],
		event: { type: "session_skills_update" },
	},
];

describe("Skill management RPC adapter", () => {
	for (const item of cases) {
		test(`maps ${item.command.type} to the authoritative service`, async () => {
			const calls: Array<{ method: ServiceMethod; args: unknown[] }> = [];
			const authoritative = { marker: item.command.type };
			const events: object[] = [];
			const response = await handleSkillManagementRpcCommand(
				item.command,
				serviceRecorder(calls, authoritative),
				event => events.push(event),
			);

			expect(calls).toEqual([{ method: item.method, args: item.args }]);
			expect(response).toMatchObject({
				id: item.command.id,
				type: "response",
				command: item.command.type,
				success: true,
			});
			if (!response.success || response.command !== item.command.type || !("data" in response)) {
				throw new Error("Expected Skill Management RPC response with data");
			}
			expect(response.data).toBe(authoritative);
			expect(events).toEqual(item.event ? [item.event] : []);
		});
	}

	test("returns a clear error when the session has no Skill Management service", async () => {
		const response = await handleSkillManagementRpcCommand({ id: "missing", type: "session_skills_get" }, undefined);

		expect(response).toEqual({
			id: "missing",
			type: "response",
			command: "session_skills_get",
			success: false,
			error: "Skill management is unavailable for this session",
			code: "skill_management_unavailable",
		});
	});

	test("preserves domain error code and current state without emitting an update event", async () => {
		const current = { activeLeafId: "leaf-2", revision: 4 };
		const service = new Proxy(
			{},
			{
				get() {
					return async () => {
						throw new SkillManagementError("stale_profile", "Profile changed", current);
					};
				},
			},
		) as SkillManagementService;
		const events: object[] = [];
		const response = await handleSkillManagementRpcCommand(
			{ id: "stale", type: "session_skills_disable", skillId: "skill-a", ...sessionContext },
			service,
			event => events.push(event),
		);

		expect(response).toEqual({
			id: "stale",
			type: "response",
			command: "session_skills_disable",
			success: false,
			error: "Profile changed",
			code: "stale_profile",
			current,
		});
		expect(events).toEqual([]);
	});
});
