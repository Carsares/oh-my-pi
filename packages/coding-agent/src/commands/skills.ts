/** Workspace-neutral Skill Catalog and Collection operations used by Picot. */

import * as os from "node:os";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { initializeWithSettings } from "../capability";
import "../discovery";
import { Settings } from "../config/settings";
import type { CreateCollectionParams, UpdateCollectionParams } from "../skills-management/collections";
import { GlobalSkillManagementService } from "../skills-management/global-service";
import type { SkillCatalogQuery } from "../skills-management/types";

type SkillRequest = {
	operation?: string;
	query?: Record<string, unknown>;
	skillId?: string;
	collectionId?: string;
	params?: Record<string, unknown>;
	expectedRevision?: number;
};

function requestError(message: string): never {
	throw new Error(`Invalid Skill Management request: ${message}`);
}

function asRequest(value: string | undefined): SkillRequest {
	if (!value) requestError("--request is required");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		requestError(`request is not valid JSON: ${String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) requestError("request must be an object");
	return parsed as SkillRequest;
}

export default class Skills extends Command {
	static description = "Manage the workspace-neutral Skill Catalog and Collections";

	static flags = {
		request: Flags.string({ description: "JSON Skill Management request", required: true }),
		cwd: Flags.string({ description: "Discovery scope (defaults to the user home)" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Skills);
		const request = asRequest(flags.request);
		const cwd = flags.cwd?.trim() || os.homedir();
		const settings = await Settings.loadIsolated({ cwd });
		initializeWithSettings(settings);
		const service = new GlobalSkillManagementService(settings, { cwd });
		const operation = request.operation;
		let result: unknown;
		switch (operation) {
			case "catalog_list":
				result = await service.listCatalog((request.query ?? {}) as SkillCatalogQuery);
				break;
			case "catalog_get":
				if (!request.skillId) requestError("skillId is required for catalog_get");
				result = await service.getCatalogEntry(request.skillId);
				break;
			case "catalog_rescan":
				result = await service.rescanCatalog();
				break;
			case "collection_list":
				result = await service.listCollections();
				break;
			case "collection_get":
				if (!request.collectionId) requestError("collectionId is required for collection_get");
				result = await service.getCollection(request.collectionId);
				break;
			case "collection_create":
				result = await service.createCollection((request.params ?? {}) as unknown as CreateCollectionParams, {
					expectedRevision: request.expectedRevision ?? requestError("expectedRevision is required"),
				});
				break;
			case "collection_update":
				result = await service.updateCollection((request.params ?? {}) as unknown as UpdateCollectionParams, {
					expectedRevision: request.expectedRevision ?? requestError("expectedRevision is required"),
				});
				break;
			case "collection_delete":
				if (!request.collectionId) requestError("collectionId is required for collection_delete");
				result = await service.deleteCollection(request.collectionId, {
					expectedRevision: request.expectedRevision ?? requestError("expectedRevision is required"),
				});
				break;
			case "collection_set_default":
				if (!request.collectionId) requestError("collectionId is required for collection_set_default");
				result = await service.setDefaultCollection(request.collectionId, {
					expectedRevision: request.expectedRevision ?? requestError("expectedRevision is required"),
				});
				break;
			default:
				requestError(`unsupported operation: ${operation ?? "<missing>"}`);
		}
		process.stdout.write(`${JSON.stringify(result)}\n`);
	}
}
